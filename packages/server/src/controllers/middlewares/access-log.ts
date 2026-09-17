/** One line per API request: the matched route pattern, never the URL as sent; refusals (401/403) at debug level so bots cannot fill the operator log. */
import type { IHttpServerComponent } from "@dcl/core-commons";
import { appLogger } from "../../adapters/log-buffer.js";
import { statusOf } from "../handlers/error-handler.js";
import type { ApiContext } from "./identity.js";

export async function accessLogMiddleware(context: ApiContext, next: () => Promise<IHttpServerComponent.IResponse>): Promise<IHttpServerComponent.IResponse> {
  const began = Date.now();
  let status = 500;
  try {
    const response = await next();
    status = response.status ?? 200;
    return response;
  } catch (error) {
    // the error handler outside turns the throw into the answer; the line must say what the client got
    status = statusOf(error);
    throw error;
  } finally {
    const log = appLogger(context.components.logs, "http");
    const fields = { method: context.request.method, route: context.routerPath ?? "/api/(.*)", status, ms: Date.now() - began, owner: context.identity?.owner, kind: context.identity?.kind };
    // the site's polling (queue and run list every few seconds per open tab) is not worth a line anywhere
    const polling = context.request.method === "GET" && (fields.route === "/api/queue" || fields.route === "/api/runs") && status === 200;
    if (!polling) {
      if (status === 401 || status === 403) log.debug("request", fields);
      else log.info("request", fields);
    }
  }
}
