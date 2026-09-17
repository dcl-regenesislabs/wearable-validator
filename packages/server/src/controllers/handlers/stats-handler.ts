import type { HandlerContextWithPath } from "../../types.js";

/** Totals, by day and by curator, the average render time and the line: operators only (routes.ts mounts the check). */
export async function statsHandler(context: Pick<HandlerContextWithPath<"runs", "/api/stats">, "components">) {
  return { status: 200, body: context.components.runs.stats() };
}
