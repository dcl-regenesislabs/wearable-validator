import type { HandlerContextWithPath } from "../../types.js";

/** Totals, by day and by curator, the average render time and the line: operators only (routes.ts mounts the check). */
export async function statsHandler(context: Pick<HandlerContextWithPath<"runs" | "buildInfo", "/api/stats">, "components">) {
  const { runs, buildInfo } = context.components;
  return { status: 200, body: { ...runs.stats(), build: { version: buildInfo.version, commit: buildInfo.commit, builtAt: buildInfo.builtAt, startedAt: buildInfo.startedAt } } };
}
