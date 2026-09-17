/** What a refused request may leave in the log: never an attacker's bytes as written. */
import { createHash } from "node:crypto";

const SAFE = /^[A-Za-z0-9._~/-]$/;

export function encodeForLog(value: string, max = 100): string {
  let out = "";
  for (const char of value.slice(0, max)) {
    out += SAFE.test(char) ? char : [...Buffer.from(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  }
  return out;
}

/** A Host header as the log carries it: eight hex characters of its sha256 and its length, never the text. */
export function hostFingerprint(header: string | null | undefined): string {
  const value = header ?? "";
  return `${createHash("sha256").update(value).digest("hex").slice(0, 8)}/${value.length}`;
}

/** The first path segment after /api/ ("runs", "stats"): all an unidentified request gets to say about where it went. */
export function apiSegment(pathname: string): string {
  const [segment = ""] = pathname.replace(/^\/api\/?/, "").split("/");
  return encodeForLog(segment, 40);
}
