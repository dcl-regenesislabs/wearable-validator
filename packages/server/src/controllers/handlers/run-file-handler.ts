import { NotFoundError } from "@dcl/http-commons";
import { fileWithin } from "../../adapters/site.js";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

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
  return { status: 200, headers: { "content-type": file.contentType, "cache-control": "no-cache" }, body: file.bytes };
}
