import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { pngBytes } from "./synthetic.js";

export function cyclicGlb(children: number[][] = [[0]]): Uint8Array {
  const json = JSON.stringify({ asset: { version: "2.0" }, nodes: children.map((children) => ({ mesh: 0, children })), meshes: [{ primitives: [] }] });
  const text = new TextEncoder().encode(json);
  const bytes = new Uint8Array(20 + Math.ceil(text.length / 4) * 4).fill(32);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, bytes.length], [12, bytes.length - 20], [16, 0x4e4f534a]]) view.setUint32(offset, value, true);
  bytes.set(text, 20);
  return bytes;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

export function oversizedPngData(): Uint8Array {
  const png = pngBytes(1, 1);
  return Buffer.concat([png.subarray(0, 33), pngChunk("IDAT", deflateSync(new Uint8Array(1024 * 1024))), png.subarray(-12)]);
}

export function duplicatePngHeader(): Uint8Array {
  const small = pngBytes(1, 1);
  const large = pngBytes(32, 32);
  return Buffer.concat([small.subarray(0, 33), large.subarray(8)]);
}

export function pngWithProfile(profile: Uint8Array): Uint8Array {
  const png = pngBytes(1, 1);
  return Buffer.concat([png.subarray(0, 33), pngChunk("iCCP", Buffer.concat([Buffer.from("profile\0\0"), profile])), png.subarray(33)]);
}

export async function oversizedManifestZip(declaredSize: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("wearable.json", JSON.stringify({ name: "Test", category: "hat" }));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 30 <= bytes.length; offset++) {
    const magic = view.getUint32(offset, true);
    if (magic === 0x04034b50) view.setUint32(offset + 22, declaredSize, true);
    if (magic === 0x02014b50) view.setUint32(offset + 24, declaredSize, true);
  }
  return bytes;
}
