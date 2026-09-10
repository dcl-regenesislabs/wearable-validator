import * as hashing from "@dcl/hashing";

// Native Node ESM exposes this CommonJS package under default; Vite exposes its named exports.
const { hashV0, hashV1 } = "default" in hashing ? hashing.default as typeof hashing : hashing;

export function contentHash(bytes: Uint8Array, version: 0 | 1 = 1): Promise<string> {
  return version === 0 ? hashV0(bytes) : hashV1(bytes);
}
