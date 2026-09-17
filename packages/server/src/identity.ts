/**
 * Who is calling the run server: every run belongs to an owner, and every /api route past /health needs one.
 * Providers plug into one seam — local (a developer's own machine), Cloudflare Access (the curators site), and
 * later ADR-44 signed fetch for the Builder (owner = wallet address) without touching server.ts.
 * Previous hop: main.ts picks the provider from the environment. Next hop: server.ts calls identify(req) per request.
 */
import type { IncomingMessage } from "node:http";
import type { AccessVerifier } from "./access.js";

export interface Identity {
  owner: string;
  kind: "local" | "access" | "service";
  /** Sees every run, the stats and the log: service tokens (the Slack bot) and the emails in OPERATORS. Local runs are always operators. */
  operator: boolean;
}

export type Identify = (req: IncomingMessage) => Promise<Identity | undefined>;

/** Everyone is the same owner: the server is only reachable by whoever started it. */
export function localIdentity(owner = "local"): Identify {
  return async () => ({ owner, kind: "local", operator: true });
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || undefined;
  }
  return undefined;
}

/**
 * The Access JWT arrives as a header through the Worker forward; the CF_Authorization cookie is the fallback for direct calls.
 * A service token (Access "Service Auth" policy) becomes owner "service:<name>" and an operator; people are operators only when listed.
 */
export function accessIdentity(verifier: AccessVerifier, operators: string[] = []): Identify {
  const listed = new Set(operators.map((email) => email.trim().toLowerCase()).filter(Boolean));
  return async (req) => {
    const header = req.headers["cf-access-jwt-assertion"];
    const token = (Array.isArray(header) ? header[0] : header) ?? cookie(req, "CF_Authorization");
    if (!token) return undefined;
    const claims = await verifier.verify(token);
    if (!claims) return undefined;
    if (claims.email) return { owner: claims.email, kind: "access", operator: listed.has(claims.email.toLowerCase()) };
    return claims.serviceName ? { owner: `service:${claims.serviceName}`, kind: "service", operator: true } : undefined;
  };
}
