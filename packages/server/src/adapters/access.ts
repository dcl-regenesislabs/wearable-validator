/** Cloudflare Access JWT verification with node:crypto only. */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export interface AccessClaims {
  /** A person who signed in; absent for a service token. */
  email?: string;
  /** A service token's name (the `common_name` claim); absent for a person. */
  serviceName?: string;
  sub: string;
}

export interface AccessVerifierOptions {
  /** The team slug: <teamDomain>.cloudflareaccess.com issues the tokens. */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
  /** Where the signing keys come from; defaults to the team's /cdn-cgi/access/certs. */
  fetchKeys?: () => Promise<AccessJwk[]>;
  /** Milliseconds since the epoch; injectable so tests drive expiry and the refresh window. */
  now?: () => number;
  /** How long to wait for the signing keys before giving up; a hung endpoint must not hold every sign-in. */
  certsTimeoutMs?: number;
}

export interface AccessVerifier {
  /** Undefined for a token that does not verify; rejects only when the keys could not be fetched (the caller answers 503, not 401). */
  verify(token: string): Promise<AccessClaims | undefined>;
}

/** An unknown kid triggers a key refresh at most this often, so a forged token cannot make us hammer Cloudflare. */
const REFRESH_INTERVAL_MS = 60_000;
/** A certs fetch that hangs must not hold every sign-in with it; cached keys keep serving meanwhile. */
const CERTS_TIMEOUT_MS = 5_000;

export function certsUrl(teamDomain: string): string {
  return `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

function isJwk(value: unknown): value is AccessJwk {
  if (!value || typeof value !== "object") return false;
  const jwk = value as Record<string, unknown>;
  return typeof jwk.kid === "string" && typeof jwk.kty === "string" && typeof jwk.n === "string" && typeof jwk.e === "string";
}

async function fetchAccessKeys(url: string, timeoutMs: number): Promise<AccessJwk[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Cloudflare Access certs answered ${res.status} at ${url}.`);
  const body: unknown = await res.json();
  const keys = body && typeof body === "object" && "keys" in body && Array.isArray(body.keys) ? (body.keys as unknown[]) : undefined;
  if (!keys) throw new Error(`Cloudflare Access certs at ${url} did not return a key list.`);
  return keys.filter(isJwk);
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  const issuer = `https://${options.teamDomain}.cloudflareaccess.com`;
  const now = options.now ?? Date.now;
  const fetchKeys = options.fetchKeys ?? (() => fetchAccessKeys(certsUrl(options.teamDomain), options.certsTimeoutMs ?? CERTS_TIMEOUT_MS));
  let keys = new Map<string, KeyObject>();
  let lastFetch = -Infinity;
  let pending: Promise<void> | undefined;

  // keys are replaced only by a successful fetch: a failed refresh keeps serving what is cached and is retried after the interval
  function refresh(): Promise<void> {
    pending ??= (async () => {
      lastFetch = now();
      try {
        const next = new Map<string, KeyObject>();
        for (const jwk of await fetchKeys()) {
          if (jwk.kty !== "RSA") continue;
          next.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" }));
        }
        keys = next;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const cached = keys.get(kid);
    if (cached) return cached;
    if (now() - lastFetch < REFRESH_INTERVAL_MS) return undefined;
    await refresh();
    return keys.get(kid);
  }

  return {
    async verify(token) {
      const [head, body, signature, ...rest] = token.split(".");
      if (!head || !body || signature === undefined || rest.length > 0) return undefined;
      const header = decodeSegment(head);
      const payload = decodeSegment(body);
      if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return undefined;
      const key = await keyFor(header.kid);
      if (!key) return undefined;
      let signed = false;
      try {
        signed = verify("sha256", Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"));
      } catch {
        return undefined;
      }
      if (!signed) return undefined;
      if (typeof payload.exp !== "number" || payload.exp <= Math.floor(now() / 1000)) return undefined;
      if (payload.iss !== issuer) return undefined;
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(options.audience)) return undefined;
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      if (typeof payload.email === "string" && payload.email.length > 0) return { email: payload.email, sub };
      // Access issues service-token JWTs with common_name instead of email
      if (typeof payload.common_name === "string" && payload.common_name.length > 0) return { serviceName: payload.common_name, sub };
      return undefined;
    }
  };
}
