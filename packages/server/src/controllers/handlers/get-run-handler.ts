import { NotFoundError } from "@dcl/http-commons";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

/** A run with every event so far; someone else's run is indistinguishable from no run at all. */
export async function getRunHandler(context: HandlerContextWithPath<"runs", "/api/runs/:id"> & IdentityContext) {
  const run = await context.components.runs.find(context.params.id, callerOf(context));
  if (!run) throw new NotFoundError("Unknown run.");
  return { status: 200, body: { id: run.id, name: run.name, done: run.done, events: run.events } };
}
