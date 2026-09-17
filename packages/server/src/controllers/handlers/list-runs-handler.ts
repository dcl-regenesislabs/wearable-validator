import type { HandlerContextWithPath } from "../../types.js";
import { callerOf, type IdentityContext } from "../middlewares/identity.js";
import { refused } from "../middlewares/refusal.js";

/** The caller's runs, newest first; `?all=1` lets an operator see everyone's, with owners. */
export async function listRunsHandler(context: HandlerContextWithPath<"runs" | "logs" | "metrics", "/api/runs"> & IdentityContext) {
  const identity = callerOf(context);
  const everyone = context.url.searchParams.get("all") === "1";
  if (everyone && !identity.operator) return refused(context.components, 403, "not-operator", "Only operators can list every curator's runs.");
  return { status: 200, body: { runs: await context.components.runs.list(identity, everyone) } };
}
