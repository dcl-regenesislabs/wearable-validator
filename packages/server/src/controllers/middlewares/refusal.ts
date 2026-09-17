/** A refusal is counted by reason and printed at debug level only: the host's collector sees it, the ring buffer and /api/logs never do. */
import type { IHttpServerComponent } from "@dcl/core-commons";
import { appLogger } from "../../adapters/log-buffer.js";
import type { BaseComponents } from "../../types.js";

export type RefusalReason = "host" | "no-identity" | "not-operator" | "read-only-service" | "cross-site";

export function refused(
  components: Pick<BaseComponents, "logs" | "metrics">,
  status: 401 | 403,
  reason: RefusalReason,
  message: string,
  fields: Record<string, unknown> = {}
): IHttpServerComponent.IResponse {
  components.metrics.increment("refused_requests_total", { reason });
  appLogger(components.logs, "http").debug("request refused", { reason, ...fields });
  return { status, body: { message } };
}
