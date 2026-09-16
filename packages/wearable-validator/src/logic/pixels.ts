/** Pixel measurements on captures — deterministic, no model. Used by render-valid and, as a guard, before any model call. */
import { decodePngSafe } from "./images.js";

/**
 * Share of pixels that are not backdrop. The previewer's backdrop is a smooth vertical gradient, so every
 * row is near one color; a pixel farther than `tolerance` (per channel sum / 3) from its row's median is
 * something drawn. Measured on real captures: an item alone reads 12–23 %, a worn avatar 8–13 %.
 */
export function subjectRatio(bytes: Uint8Array, tolerance: number): number | undefined {
  const png = decodePngSafe(bytes);
  if (!png || png.depth !== 8 || png.channels < 3) return undefined;
  const { width, height, channels, data } = png;
  const row = new Int32Array(width);
  let subject = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      row[x] = data[o] + data[o + 1] + data[o + 2];
    }
    const median = row.slice().sort()[width >> 1];
    for (let x = 0; x < width; x++) if (Math.abs(row[x] - median) > tolerance * 3) subject++;
  }
  return subject / (width * height);
}
