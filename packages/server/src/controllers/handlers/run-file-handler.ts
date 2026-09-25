import { posix } from "node:path";
import { NotFoundError } from "@dcl/http-commons";
import { fileWithin } from "../../adapters/site.js";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

// what a browser may display: item/ holds whatever files a published item lists, so an .html or .svg there must never run on this origin
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "application/json", "text/markdown; charset=utf-8"]);
// the run's own gallery (run-store writeRun) is the one page; the sandbox keeps any page here scriptless and cookie-less
const RUN_FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

/** Files from the run folder (captures/*.png, thumbnail.png, <check>/1-prompt.md …), path-safe: nothing outside the folder is ever read. */
export async function runFileHandler(context: HandlerContextWithPath<"runs", "/api/runs/:id/(.*)"> & IdentityContext) {
  const { id } = context.params;
  const run = await context.components.runs.find(id, callerOf(context));
  if (!run) throw new NotFoundError("Unknown run.");
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(context.url.pathname.slice(`/api/runs/${id}/`.length));
  } catch {
    throw new NotFoundError("Not found.");
  }
  const file = await fileWithin(run.dir, relativePath);
  if (!file) throw new NotFoundError("Not found.");
  const inline = INLINE_TYPES.has(file.contentType) || posix.normalize(relativePath) === "index.html";
  const headers: Record<string, string> = {
    "content-type": inline || file.contentType === "application/zip" ? file.contentType : "application/octet-stream",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": RUN_FILE_CSP
  };
  if (!inline) headers["content-disposition"] = `attachment; filename="${posix.basename(relativePath).replace(/[^\w.-]/g, "_")}"`;
  return { status: 200, headers, body: file.bytes };
}
