import { enc } from "./bytes.js";

/** Re-encodes a GLB with its JSON chunk mutated (raw-JSON scenarios gltf-transform can't author). */
export function patchGlbJson(glb: Uint8Array, mutate: (json: Record<string, unknown>) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
  mutate(json);
  let jsonBytes = enc(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad) {
    const padded = new Uint8Array(jsonBytes.length + pad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const rest = glb.subarray(20 + jsonLength);
  const out = new Uint8Array(12 + 8 + jsonBytes.length + rest.length);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true); // 'glTF'
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.length, true);
  outView.setUint32(12, jsonBytes.length, true);
  outView.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.length);
  return out;
}
