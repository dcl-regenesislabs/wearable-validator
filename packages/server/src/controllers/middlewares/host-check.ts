/** A page that DNS-rebinds its hostname to this address is same-origin with us, but its Host header still names the attacker. The health probe is exempt so a load balancer can call it by IP. */
import type { IHttpServerComponent } from "@dcl/core-commons";
import { appLogger } from "../../adapters/log-buffer.js";
import { hostAllowed, isLoopback, parseHostList } from "../../logic/hosts.js";
import { hostFingerprint } from "../../logic/redact.js";
import type { BaseComponents, GlobalContext } from "../../types.js";
import { refused } from "./refusal.js";

export async function createHostCheckMiddleware(components: Pick<BaseComponents, "config" | "logs">): Promise<IHttpServerComponent.IRequestHandler<GlobalContext>> {
  const { config, logs } = components;
  const host = await config.requireString("HTTP_SERVER_HOST");
  const publicHosts = parseHostList(await config.getString("PUBLIC_HOSTS"));
  const enabled = isLoopback(host) || publicHosts.length > 0;
  if (!enabled) appLogger(logs, "http").warn("Host header check skipped: set PUBLIC_HOSTS to the hostnames this server answers on", { host });
  return async (context, next) => {
    const header = context.request.headers.get("host");
    if (!enabled || context.url.pathname === "/api/health" || hostAllowed(header, host, publicHosts)) return next();
    return refused(context.components, 403, "host", "This server only answers requests addressed to its own host.", { host: hostFingerprint(header) });
  };
}
