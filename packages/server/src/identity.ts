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
  kind: "local" | "access";
}

export type Identify = (req: IncomingMessage) => Promise<Identity | undefined>;

/** Everyone is the same owner: the server is only reachable by whoever started it. */
export function localIdentity(owner = "local"): Identify {
  return async () => ({ owner, kind: "local" });
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

/** The Access JWT arrives as a header through the Worker forward; the CF_Authorization cookie is the fallback for direct calls. */
export function accessIdentity(verifier: AccessVerifier): Identify {
  return async (req) => {
    const header = req.headers["cf-access-jwt-assertion"];
    const token = (Array.isArray(header) ? header[0] : header) ?? cookie(req, "CF_Authorization");
    if (!token) return undefined;
    const claims = await verifier.verify(token);
    return claims ? { owner: claims.email, kind: "access" } : undefined;
  };
}
