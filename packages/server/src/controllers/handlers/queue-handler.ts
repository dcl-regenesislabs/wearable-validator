import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

/** Who is rendering and who waits; the caller's own items carry id and name, another curator's item is anonymous. */
export async function queueHandler(context: HandlerContextWithPath<"runs", "/api/queue"> & IdentityContext) {
  return { status: 200, body: context.components.runs.queueState(callerOf(context).owner) };
}
