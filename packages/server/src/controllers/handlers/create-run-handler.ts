import { parseItemReference } from "@dcl-regenesislabs/wearable-validator";
import { referenceName, safeFileName } from "../../logic/runs.js";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
// a reference body is one URN or URL: anything larger is not one
const MAX_REFERENCE_BODY_BYTES = 4096;
const BAD_REFERENCE = "That doesn't look like a shop item URL or a wearable URN (expected decentraland.org/shop/item/0x…/N or urn:decentraland:…).";

/** Forms and no-cors fetches cannot send either type, so a browser too old to stamp Sec-Fetch-Site still cannot start a run from another site. */
function contentType(request: Request): string | undefined {
  return request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
}

/** Collects the body up to `limit`; past it the rest is drained and discarded so the 413 reaches a client still uploading. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (overflowed) continue;
    if (size > limit) {
      overflowed = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(value);
  }
  return overflowed ? undefined : new Uint8Array(Buffer.concat(chunks));
}

/** The `reference` string of a JSON body; undefined when the body is not that shape. */
function referenceOf(bytes: Uint8Array): string | undefined {
  try {
    const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const reference = raw && typeof raw === "object" ? (raw as { reference?: unknown }).reference : undefined;
    return typeof reference === "string" ? reference : undefined;
  } catch {
    return undefined;
  }
}

/** The upload or the reference becomes a run: 201 with where to follow it. Quotas (429/503) are the runs component's to refuse. */
export async function createRunHandler(context: HandlerContextWithPath<"runs" | "config", "/api/runs"> & IdentityContext) {
  const { runs, config } = context.components;
  const { request, url } = context;
  const identity = callerOf(context);
  const type = contentType(request);
  const mode = { model: url.searchParams.get("model") !== "0", standalone: url.searchParams.get("standalone") === "1" };
  if (type === "application/json") {
    const body = await readBody(request, MAX_REFERENCE_BODY_BYTES);
    if (!body) return { status: 413, body: { message: `A reference body is at most ${MAX_REFERENCE_BODY_BYTES} bytes.` } };
    const reference = referenceOf(body);
    if (reference === undefined) return { status: 400, body: { message: 'Send { "reference": "<shop item URL or URN>" } as the JSON body.' } };
    let candidates: string[] | null;
    try {
      candidates = parseItemReference(reference);
    } catch (error) {
      return { status: 400, body: { message: error instanceof Error ? error.message : BAD_REFERENCE } };
    }
    if (!candidates) return { status: 400, body: { message: BAD_REFERENCE } };
    // nothing to buffer: the slot is taken only once the reference is known to be one
    const reservation = await runs.reserve(identity);
    try {
      const accepted = await runs.accept({ identity, name: referenceName(candidates[0]), reference: candidates, ...mode, reservation });
      return { status: 201, body: accepted };
    } finally {
      reservation.release();
    }
  }
  if (type !== "application/zip") return { status: 415, body: { message: 'Send the zip bytes with content-type: application/zip, or { "reference" } as application/json.' } };
  const name = safeFileName(request.headers.get("x-file-name"));
  if (name === undefined) return { status: 400, body: { message: "x-file-name must be a URL-encoded file name." } };
  // the slot is taken before the body is read: an owner at the cap never has its next upload buffered
  const reservation = await runs.reserve(identity);
  try {
    const limit = (await config.getNumber("MAX_UPLOAD_BYTES")) ?? DEFAULT_MAX_UPLOAD_BYTES;
    const bytes = await readBody(request, limit);
    if (!bytes) return { status: 413, body: { message: `The file is larger than ${limit} bytes.` } };
    if (bytes.length === 0) return { status: 400, body: { message: "Send the zip bytes as the request body." } };
    const accepted = await runs.accept({ identity, name, bytes, ...mode, reservation });
    return { status: 201, body: accepted };
  } finally {
    reservation.release();
  }
}
