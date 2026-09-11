/** Byte-level image helpers shared by checks and adapters — no decoding beyond what a header needs. */
import { imageSize } from "image-size";
import { decode as decodePng } from "fast-png";

export function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length > 25 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Header dimensions; undefined when the bytes are not a decodable image (texture-format reports that). */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    const { width, height } = imageSize(bytes);
    return { width, height };
  } catch {
    return undefined;
  }
}

/** PNG alpha: IHDR color type 4 (gray+alpha) / 6 (RGBA), or palette (3) with a tRNS chunk. */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  if (colorType === 3) {
    for (let i = 8; i + 4 < bytes.length; i++) {
      if (bytes[i] === 0x74 && bytes[i + 1] === 0x52 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x53) return true;
    }
  }
  return false;
}

/** JPEG SOF precision (bits per channel) — scans markers for SOF0..SOF15 (minus DHT/JPG/DAC). */
export function jpegPrecision(bytes: Uint8Array): number | undefined {
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return bytes[i + 4];
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + length;
  }
  return undefined;
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  depth: number;
  data: Uint8Array | Uint16Array;
}

/** Full PNG decode that never throws; the data view is always indexable as bytes or 16-bit samples. */
export function decodePngSafe(bytes: Uint8Array): DecodedPng | undefined {
  try {
    const img = decodePng(bytes);
    // fast-png may hand back a Uint8ClampedArray — view it as Uint8Array (same buffer, same indexing).
    const data = img.data instanceof Uint16Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return { width: img.width, height: img.height, channels: img.channels, depth: img.depth, data };
  } catch {
    return undefined;
  }
}
