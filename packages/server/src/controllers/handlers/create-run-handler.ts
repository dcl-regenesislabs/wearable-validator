import { safeFileName } from "../../logic/runs.js";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Forms and no-cors fetches cannot send this type, so a browser too old to stamp Sec-Fetch-Site still cannot start a run from another site. */
function isZipUpload(request: Request): boolean {
  return request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/zip";
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

/** The upload becomes a run: 201 with where to follow it. Quotas (429/503) are the runs component's to refuse. */
export async function createRunHandler(context: HandlerContextWithPath<"runs" | "config", "/api/runs"> & IdentityContext) {
  const { runs, config } = context.components;
  const { request, url } = context;
  const identity = callerOf(context);
  if (!isZipUpload(request)) return { status: 415, body: { message: "Send the zip bytes with content-type: application/zip." } };
  const name = safeFileName(request.headers.get("x-file-name"));
  if (name === undefined) return { status: 400, body: { message: "x-file-name must be a URL-encoded file name." } };
  // the slot is taken before the body is read: an owner at the cap never has its next upload buffered
  const reservation = await runs.reserve(identity);
  try {
    const limit = (await config.getNumber("MAX_UPLOAD_BYTES")) ?? DEFAULT_MAX_UPLOAD_BYTES;
    const bytes = await readBody(request, limit);
    if (!bytes) return { status: 413, body: { message: `The file is larger than ${limit} bytes.` } };
    if (bytes.length === 0) return { status: 400, body: { message: "Send the zip bytes as the request body." } };
    const accepted = await runs.accept({ identity, name, bytes, model: url.searchParams.get("model") !== "0", standalone: url.searchParams.get("standalone") === "1", reservation });
    return { status: 201, body: accepted };
  } finally {
    reservation.release();
  }
}
