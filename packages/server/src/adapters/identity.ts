/** Who is calling: local, Cloudflare Access, the operator token — and later ADR-44 signed fetch for the Builder. */
import { timingSafeEqual } from "node:crypto";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { isLoopback } from "../logic/hosts.js";
import type { Identity } from "../types.js";
import { createAccessVerifier, type AccessVerifier } from "./access.js";

/** The part of a request a provider looks at: the WKC handler's `Request`, or anything with a `headers.get`. */
export interface IdentityRequest {
  headers: Pick<Headers, "get">;
}

/** Undefined when nobody is recognised; rejects when a provider could not decide (the caller answers 503). */
export type Identify = (request: IdentityRequest) => Promise<Identity | undefined>;

export interface IIdentityComponent {
  identify: Identify;
  /** What /api/health and the startup log say about how callers are named: "local", "cloudflare-access (…)", "anonymous". */
  kind: string;
}

/** One trusted machine caller (the Slack bot) with a shared secret: `Authorization: Bearer <OPERATOR_TOKEN>`, compared in constant time. */
export function tokenIdentity(token: string, name = "bot"): Identify {
  if (token.length < 32) throw new Error("OPERATOR_TOKEN must be at least 32 characters.");
  const expected = Buffer.from(token);
  return async (request) => {
    const value = request.headers.get("authorization") ?? "";
    if (!value.startsWith("Bearer ")) return undefined;
    const given = Buffer.from(value.slice("Bearer ".length));
    return given.length === expected.length && timingSafeEqual(given, expected) ? { owner: `service:${name}`, kind: "service", operator: true, readOnly: true } : undefined;
  };
}

/** Providers in order: the first one that recognises the caller wins. */
export function firstOf(...providers: Identify[]): Identify {
  return async (request) => {
    for (const identify of providers) {
      const identity = await identify(request);
      if (identity) return identity;
    }
    return undefined;
  };
}

/** Everyone is the same owner: the server is only reachable by whoever started it. */
export function localIdentity(owner = "local"): Identify {
  return async () => ({ owner, kind: "local", operator: true, readOnly: false });
}

function cookie(request: IdentityRequest, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || undefined;
  }
  return undefined;
}

/**
 * The Access JWT arrives as a header through the Worker forward; the CF_Authorization cookie is the fallback for direct calls.
 * A service token (Access "Service Auth" policy) becomes owner "service:<name>", an operator and read-only; people are operators only when listed.
 */
export function accessIdentity(verifier: AccessVerifier, operators: string[] = []): Identify {
  const listed = new Set(operators.map((email) => email.trim().toLowerCase()).filter(Boolean));
  return async (request) => {
    const token = request.headers.get("cf-access-jwt-assertion") ?? cookie(request, "CF_Authorization");
    if (!token) return undefined;
    const claims = await verifier.verify(token);
    if (!claims) return undefined;
    if (claims.email) return { owner: claims.email, kind: "access", operator: listed.has(claims.email.toLowerCase()), readOnly: false };
    return claims.serviceName ? { owner: `service:${claims.serviceName}`, kind: "service", operator: true, readOnly: true } : undefined;
  };
}

export interface IdentityConfig {
  host: string;
  teamDomain?: string;
  audience?: string;
  operators?: string;
  operatorToken?: string;
  insecureAnonymous: boolean;
}

/** Who owns runs: Cloudflare Access when configured, the machine's user on loopback, nobody in particular only when asked for. */
export function chooseIdentity(config: IdentityConfig): IIdentityComponent {
  const { teamDomain, audience, host } = config;
  // the shared secret is checked first: it costs nothing and the bot is the only caller that carries it
  const bot = config.operatorToken ? tokenIdentity(config.operatorToken) : undefined;
  const withBot = (identify: Identify, kind: string): IIdentityComponent => ({ identify: bot ? firstOf(bot, identify) : identify, kind: bot ? `${kind} + operator token` : kind });
  if (teamDomain || audience) {
    if (!teamDomain || !audience) throw new Error("Set both CF_ACCESS_TEAM_DOMAIN (the team slug) and CF_ACCESS_AUD (the Access application audience tag).");
    const operators = (config.operators ?? "").split(",").map((email) => email.trim()).filter(Boolean);
    return withBot(accessIdentity(createAccessVerifier({ teamDomain, audience }), operators), `cloudflare-access (${teamDomain}${operators.length ? `, ${operators.length} operators` : ""})`);
  }
  if (isLoopback(host)) return withBot(localIdentity(), "local");
  if (config.insecureAnonymous) return withBot(localIdentity("anonymous"), "anonymous");
  throw new Error(`HTTP_SERVER_HOST=${host} is reachable from other machines: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or INSECURE_ANONYMOUS=1 on a trusted network only.`);
}

export async function createIdentityComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IIdentityComponent> {
  const { config, logs } = components;
  const host = await config.requireString("HTTP_SERVER_HOST");
  const identity = chooseIdentity({
    host,
    teamDomain: await config.getString("CF_ACCESS_TEAM_DOMAIN"),
    audience: await config.getString("CF_ACCESS_AUD"),
    operators: await config.getString("OPERATORS"),
    operatorToken: await config.getString("OPERATOR_TOKEN"),
    insecureAnonymous: (await config.getString("INSECURE_ANONYMOUS")) === "1"
  });
  if (identity.kind.startsWith("anonymous")) {
    logs.getLogger("identity").warn("INSECURE_ANONYMOUS=1: every caller owns every run and nobody signs in; never expose this server beyond a trusted network", { host });
  }
  return identity;
}
