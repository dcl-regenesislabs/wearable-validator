export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export function padBytes(bytes: Uint8Array, extra: number): Uint8Array {
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes);
  return out;
}
