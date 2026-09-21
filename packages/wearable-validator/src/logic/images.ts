/** Image dimensions and bounded pixel decoding shared by checks and adapters. */
import { decode as decodePng } from "fast-png";
import { manifest } from "../manifest/index.js";
import { boundedPng, inspectPng } from "./png.js";

export function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length > 25 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** The SOF segment, walking markers the way jpeg-js does (fill bytes skipped): precision, height, width. */
function jpegFrame(bytes: Uint8Array): { precision: number; width: number; height: number } | undefined {
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) return undefined;
      return { precision: bytes[i + 4], height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    i += 2 + length;
  }
  return undefined;
}

/**
 * Header dimensions of a PNG or JPEG, read the way the decoders read them; undefined for anything else and for a
 * header that cannot be read — which every decode path treats as "do not decode", never as "small enough".
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const dimensions = isPngBytes(bytes) ? inspectPng(bytes) : isJpegBytes(bytes) ? jpegFrame(bytes) : undefined;
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? { width: dimensions.width, height: dimensions.height } : undefined;
}

/**
 * Whether an image may be decoded to pixels: a readable header whose width × height is within the budget.
 * A decoded image costs at least 4 bytes per pixel, so a 12000×12000 PNG of a few hundred KB inflates past a gigabyte.
 */
export function fitsDecodeBudget(bytes: Uint8Array, maxPixels = manifest.images.maxDecodePixels): boolean {
  const dimensions = imageDimensions(bytes);
  return dimensions !== undefined && dimensions.width * dimensions.height <= maxPixels;
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

/** JPEG SOF precision (bits per channel). */
export function jpegPrecision(bytes: Uint8Array): number | undefined {
  return jpegFrame(bytes)?.precision;
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  depth: number;
  data: Uint8Array | Uint16Array;
  palette?: number[][];
}

/** Full PNG decode that never throws and never decodes an unreadable header or one above the pixel budget; the data view is always indexable as bytes or 16-bit samples. */
export function decodePngSafe(bytes: Uint8Array, maxPixels = manifest.images.maxDecodePixels): DecodedPng | undefined {
  try {
    const safe = boundedPng(bytes, maxPixels);
    if (!safe) return undefined;
    const img = decodePng(safe);
    // fast-png may hand back a Uint8ClampedArray — view it as Uint8Array (same buffer, same indexing).
    const data = img.data instanceof Uint16Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return { width: img.width, height: img.height, channels: img.channels, depth: img.depth, data, palette: img.palette };
  } catch {
    return undefined;
  }
}
