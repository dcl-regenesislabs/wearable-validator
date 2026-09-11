/**
 * Visual evidence helpers shared by every rendering-group check — isomorphic, pure.
 * Previous hop: checks/<rule>.ts expands its recipe into CaptureRequests and calls resolveCaptures().
 * Next hop: supplied captures are reused, the rest come from services.renderer (/rendering);
 * the ordered CaptureRecords go back to the check, which hands them to services.reviewer.
 */
import { decode } from "fast-png";
import { imageSize } from "image-size";
import { isPngBytes } from "./images.js";
import type { CaptureRecord, CaptureRequest, CheckContext, RenderInput } from "../types.js";

export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** sha256 of JSON with recursively sorted keys — key order never changes an identity. */
export function digestJson(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
  return digest(new TextEncoder().encode(canonical));
}

/** Everything that changes what the renderer draws: declared file bytes plus the metadata the previewer reads. */
export async function inputDigest(ctx: CheckContext): Promise<string> {
  const paths = [...new Set(ctx.item.representations?.flatMap((rep) => rep.contents) ?? [])].sort();
  const files: [string, string][] = [];
  for (const path of paths) {
    const bytes = ctx.files.get(path);
    if (bytes) files.push([path, await digest(bytes)]);
  }
  return digestJson({
    files,
    category: ctx.category,
    itemType: ctx.itemType,
    representations: ctx.item.representations,
    hides: ctx.item.hides ?? [],
    replaces: ctx.item.replaces ?? [],
    loop: ctx.item.loop,
    springBones: ctx.item.springBones
  });
}

/** The renderer's build, else the one build every supplied capture shares; undefined for none or mixed. */
export function rendererBuild(ctx: CheckContext): string | undefined {
  if (ctx.services?.renderer) return ctx.services.renderer.buildId;
  const builds = new Set(ctx.captures?.map((capture) => capture.request.rendererBuild));
  return builds.size === 1 ? [...builds][0] : undefined;
}

/** Fills id (PNG stem / model image id) and key (reuse identity: every field + the scene settings). */
export async function captureRequest(ctx: CheckContext, fields: Omit<CaptureRequest, "id" | "key">): Promise<CaptureRequest> {
  const { profile, background, skin, wearablePose, wearablePoseFraction } = ctx.manifest.rendering;
  const shape = fields.bodyShape.split(":").pop() ?? fields.bodyShape;
  const time = fields.timeFraction === undefined ? "" : `-t${fields.timeFraction}`;
  const id = `${shape}-${fields.view}-${String(fields.azimuthDegrees).padStart(3, "0")}${time}`;
  const key = await digestJson({ ...fields, scene: { profile, background, skin, wearablePose, wearablePoseFraction } });
  return { id, key, ...fields };
}

/** A capture counts only when it is the PNG the request asked for and its bytes match its own sha256. */
export async function validCapture(capture: CaptureRecord, request: CaptureRequest, maxBytes: number): Promise<boolean> {
  try {
    if (!(capture.bytes instanceof Uint8Array) || capture.bytes.length > maxBytes || !isPngBytes(capture.bytes)) return false;
    if ((await digestJson(capture.request)) !== (await digestJson(request))) return false;
    if ((await digest(capture.bytes)) !== capture.sha256) return false;
    const header = imageSize(capture.bytes);
    if (header.type !== "png" || header.width !== request.size || header.height !== request.size) return false;
    const png = decode(capture.bytes);
    return png.width === request.size && png.height === request.size && capture.width === png.width && capture.height === png.height;
  } catch {
    return false;
  }
}

/**
 * supplied → render the missing → verify every key came back → write back to ctx.captures.
 * Returns a creator-facing reason instead of records when views are missing and no renderer is configured.
 */
export async function resolveCaptures(ctx: CheckContext, requests: CaptureRequest[]): Promise<CaptureRecord[] | string> {
  const { maxCaptureBytes } = ctx.manifest.rendering;
  const resolved = new Map<string, CaptureRecord>();
  const missing: CaptureRequest[] = [];
  for (const request of requests) {
    ctx.signal?.throwIfAborted();
    const supplied = ctx.captures?.find((capture) => capture.request.key === request.key);
    if (supplied && (await validCapture(supplied, request, maxCaptureBytes))) resolved.set(request.key, supplied);
    else missing.push(request);
  }
  if (missing.length) {
    const renderer = ctx.services?.renderer;
    if (!renderer) return `Supply ${missing.length} missing or stale rendered views, or configure services.renderer to capture them.`;
    const input: RenderInput = { files: ctx.files, item: ctx.item, itemType: ctx.itemType, category: ctx.category! };
    const generated = await renderer.capture(input, missing, ctx.signal);
    for (const request of missing) {
      ctx.signal?.throwIfAborted();
      const capture = generated.find((value) => value.request.key === request.key);
      if (!capture || !(await validCapture(capture, request, maxCaptureBytes))) {
        throw new Error(`The renderer did not return a valid ${request.id} view. Capture the views again.`);
      }
      resolved.set(request.key, capture);
    }
  }
  const captures = requests.map((request) => resolved.get(request.key)!);
  // other rules' captures stay in the result so one run can feed several checks — but only valid ones,
  // and never a stale capture whose id (file name) collides with a view resolved here
  const ids = new Set(requests.map((request) => request.id));
  const others: CaptureRecord[] = [];
  for (const capture of ctx.captures ?? []) {
    if (resolved.has(capture.request.key) || ids.has(capture.request.id)) continue;
    if (await validCapture(capture, capture.request, maxCaptureBytes)) others.push(capture);
  }
  ctx.captures = [...captures, ...others];
  return captures;
}
