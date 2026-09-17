/** Thrown errors become JSON the web app understands; an unexpected one is a 500 with a reference, and the reason (paths, upstream URLs) stays in the log. */
import { randomBytes } from "node:crypto";
import type { IHttpServerComponent } from "@dcl/core-commons";
import { InvalidRequestError, NotAuthorizedError, NotFoundError } from "@dcl/http-commons";
import { appLogger } from "../../adapters/log-buffer.js";
import { HttpError } from "../../logic/errors.js";
import type { GlobalContext } from "../../types.js";

type ErrorContext = IHttpServerComponent.DefaultContext<GlobalContext> & { routerPath?: string };

/** The status a thrown error answers with; the access log and the metrics label use the same rule. */
export function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof InvalidRequestError) return 400;
  if (error instanceof NotAuthorizedError) return 401;
  if (error instanceof NotFoundError) return 404;
  return 500;
}

export async function errorHandler(context: ErrorContext, next: () => Promise<IHttpServerComponent.IResponse>): Promise<IHttpServerComponent.IResponse> {
  try {
    return await next();
  } catch (error) {
    const status = statusOf(error);
    if (error instanceof HttpError) return { status, headers: error.headers, body: { message: error.message } };
    if (status !== 500 && error instanceof Error) return { status, body: { message: error.message } };
    const reference = randomBytes(4).toString("hex");
    appLogger(context.components.logs, "http").error("request failed", {
      reference,
      method: context.request.method,
      route: context.routerPath ?? "unmatched",
      error: error instanceof Error ? error.message : String(error)
    });
    return { status: 500, body: { message: "Request failed.", reference } };
  }
}
