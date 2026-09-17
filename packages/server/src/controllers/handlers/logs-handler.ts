import type { HandlerContextWithPath } from "../../types.js";

const DEFAULT_LIMIT = 200;

/** The recent log lines kept in memory since the last restart; `since` (ISO time) drops what the caller already has. Operators only. */
export async function logsHandler(context: Pick<HandlerContextWithPath<"logBuffer", "/api/logs">, "components" | "url">) {
  const limit = Number(context.url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const since = context.url.searchParams.get("since") ?? undefined;
  return { status: 200, body: { lines: context.components.logBuffer.recent(limit, since) } };
}
