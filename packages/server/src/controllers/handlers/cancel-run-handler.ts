import { NotFoundError } from "@dcl/http-commons";
import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";

/** Stops a waiting or rendering run; a finished one is left as it is. */
export async function cancelRunHandler(context: HandlerContextWithPath<"runs", "/api/runs/:id"> & IdentityContext) {
  const { id } = context.params;
  const cancelled = await context.components.runs.cancel(id, callerOf(context));
  if (!cancelled) throw new NotFoundError("Unknown run.");
  return { status: 202, body: { id, cancelled: true } };
}
