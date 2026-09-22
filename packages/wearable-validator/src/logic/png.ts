import { Inflate } from "pako";
import { manifest } from "../manifest/index.js";

interface Chunk {
  type: string;
  bytes: Uint8Array;
  data: Uint8Array;
}

interface Png {
  width: number;
  height: number;
  depth: number;
  channels: number;
  interlace: number;
  chunks: Chunk[];
  ended: boolean;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PIXEL_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export function inspectPng(bytes: Uint8Array): Png | undefined {
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let header: Omit<Png, "chunks" | "ended"> | undefined;
  let ended = false;
  let pixels = false;
  let pixelsEnded = false;
  let offset = SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return undefined;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, end - 4);
    if (type === "IHDR") {
      if (header || pixels || length !== 13) return undefined;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      const depth = data[8];
      const color = data[9];
      const channels = CHANNELS[color];
      if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth)) return undefined;
      if ((color === 3 && depth === 16) || (color !== 0 && color !== 3 && depth < 8)) return undefined;
      if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) return undefined;
      header = { width, height, depth, channels, interlace: data[12] };
    } else if (type === "IDAT") {
      if (!header || pixelsEnded) return undefined;
      pixels = true;
    } else {
      if (pixels) pixelsEnded = true;
      if (type === "IEND") {
        if (length !== 0 || end !== bytes.length) return undefined;
        ended = true;
      } else if (type === "PLTE" || type === "tRNS") {
        if (!header || pixels || chunks.some((chunk) => chunk.type === type)) return undefined;
        if (type === "PLTE" && (!length || length > 256 * 3 || length % 3 !== 0)) return undefined;
        if (type === "tRNS" && length > 256) return undefined;
      } else if ((bytes[offset + 4] & 32) === 0) return undefined;
    }
    if (PIXEL_CHUNKS.has(type)) chunks.push({ type, data, bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  return header && offset === bytes.length ? { ...header, chunks, ended } : undefined;
}

function scanlineBytes(png: Png): number {
  const passes = png.interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
  let total = 0;
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((png.width - x) / dx));
    const height = Math.max(0, Math.ceil((png.height - y) / dy));
    if (width && height) total += height * (1 + Math.ceil(width * png.channels * png.depth / 8));
  }
  return total;
}

export function boundedPng(bytes: Uint8Array, maxPixels: number): Uint8Array | undefined {
  const png = inspectPng(bytes);
  if (!png?.ended || png.width * png.height > maxPixels) return undefined;
  const data = png.chunks.filter((chunk) => chunk.type === "IDAT" && chunk.data.length > 0);
  if (!data.length) return undefined;
  const expected = scanlineBytes(png);
  const inflater = new Inflate({ chunkSize: Math.min(expected + 1, manifest.images.inflateChunkBytes) });
  let inflated = 0;
  inflater.onData = (chunk) => {
    inflated += chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.length;
    if (inflated > expected) throw new Error("PNG pixel data exceeds its declared dimensions.");
  };
  for (let i = 0; i < data.length; i++) {
    if (!inflater.push(data[i].data, i === data.length - 1)) return undefined;
  }
  if (inflater.err || inflated !== expected) return undefined;

  // Pixel measurements need no profiles or text; never let their compressed streams reach the decoder.
  const chunks = png.chunks;
  const safe = new Uint8Array(SIGNATURE.length + chunks.reduce((total, chunk) => total + chunk.bytes.length, 0));
  safe.set(SIGNATURE);
  let offset = SIGNATURE.length;
  for (const chunk of chunks) {
    safe.set(chunk.bytes, offset);
    offset += chunk.bytes.length;
  }
  return safe;
}
