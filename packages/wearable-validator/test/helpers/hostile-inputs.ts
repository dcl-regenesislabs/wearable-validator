import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { pngBytes } from "./synthetic.js";

/** A GLB container around any JSON, with an optional BIN chunk: the hostile shapes live in the JSON. */
export function glbBytes(json: unknown, bin?: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const bytes = new Uint8Array(20 + jsonLength + (bin ? 8 + binLength : 0));
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, bytes.length], [12, jsonLength], [16, 0x4e4f534a]]) view.setUint32(offset, value, true);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(text, 20);
  if (bin) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    bytes.set(bin, 28 + jsonLength);
  }
  return bytes;
}

export function cyclicGlb(children: number[][] = [[0]]): Uint8Array {
  return glbBytes({ asset: { version: "2.0" }, nodes: children.map((children) => ({ mesh: 0, children })), meshes: [{ primitives: [] }] });
}

/** A few hundred bytes whose accessors ask the parser for gigabytes: a zero stride over 64 real bytes, or no buffer view at all. */
export function amplifyingGlb(shape: "zero-stride" | "no-buffer-view"): Uint8Array {
  const accessor = shape === "zero-stride" ? { bufferView: 0, componentType: 5126, type: "MAT4", count: 20_000_000 } : { componentType: 5126, type: "MAT4", count: 20_000_000 };
  const bufferView = shape === "zero-stride" ? { buffer: 0, byteLength: 64, byteStride: 0 } : { buffer: 0, byteLength: 64 };
  return glbBytes({ asset: { version: "2.0" }, buffers: [{ byteLength: 64 }], bufferViews: [bufferView], accessors: [accessor, accessor, accessor, accessor] }, new Uint8Array(64));
}

/** One embedded image listed `copies` times: every entry is a separate copy once parsed. */
export function repeatedImageGlb(png: Uint8Array, copies: number): Uint8Array {
  return glbBytes({
    asset: { version: "2.0" },
    buffers: [{ byteLength: Math.ceil(png.length / 4) * 4 }],
    bufferViews: [{ buffer: 0, byteLength: png.length }],
    images: Array.from({ length: copies }, (_, i) => ({ bufferView: 0, mimeType: "image/png", name: `copy ${i}` }))
  }, png);
}

/** `length` nodes each holding the same triangle, every one the child of the one before. */
export function nodeChainGlb(length: number): Uint8Array {
  const nodes = Array.from({ length }, (_, i) => (i < length - 1 ? { mesh: 0, children: [i + 1] } : { mesh: 0 }));
  return glbBytes({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3, min: [0, 0, 0], max: [0, 0, 0] }]
  }, new Uint8Array(36));
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
