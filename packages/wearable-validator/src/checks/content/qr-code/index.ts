/** F-04 QR codes — a scannable code's target can change after review, so any readable one is rejected. */
import jsQR from "jsqr";
import { decode as decodePng } from "fast-png";
import { decode as decodeJpeg } from "jpeg-js";
import { isJpegBytes, isPngBytes } from "../../../logic/images.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { POLICY } from "../../docs.js";

const meta: CheckMeta = { name: "qr-code", group: "content", rule: "F-04", docs: POLICY };

interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decode PNG/JPEG bytes to RGBA for jsQR. Undecodable/unsupported images return undefined (texture-format's territory). */
function toRgba(bytes: Uint8Array): RgbaImage | undefined {
  try {
    if (isPngBytes(bytes)) {
      const png = decodePng(bytes);
      const { width, height, channels, depth, palette } = png;
      if (depth !== 8 && depth !== 16) return undefined;
      const src = png.data;
      const to8 = (v: number): number => (depth === 16 ? v >> 8 : v);
      const pixels = width * height;
      const out = new Uint8ClampedArray(pixels * 4);
      if (palette && channels === 1) {
        for (let i = 0; i < pixels; i++) {
          const entry = palette[src[i]] ?? [0, 0, 0];
          out[i * 4] = entry[0]; out[i * 4 + 1] = entry[1]; out[i * 4 + 2] = entry[2];
          out[i * 4 + 3] = entry.length > 3 ? entry[3] : 255;
        }
        return { data: out, width, height };
      }
      for (let i = 0; i < pixels; i++) {
        const o = i * channels;
        let r = 0, g = 0, b = 0, a = 255;
        switch (channels) {
          case 1: r = g = b = to8(src[o]); break;
          case 2: r = g = b = to8(src[o]); a = to8(src[o + 1]); break;
          case 3: r = to8(src[o]); g = to8(src[o + 1]); b = to8(src[o + 2]); break;
          case 4: r = to8(src[o]); g = to8(src[o + 1]); b = to8(src[o + 2]); a = to8(src[o + 3]); break;
          default: return undefined;
        }
        out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
      }
      return { data: out, width, height };
    }
    if (isJpegBytes(bytes)) {
      const jpg = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
      return { data: new Uint8ClampedArray(jpg.data.buffer, jpg.data.byteOffset, jpg.data.length), width: jpg.width, height: jpg.height };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function decodeQr(bytes: Uint8Array): string | undefined {
  const rgba = toRgba(bytes);
  if (!rgba) return undefined;
  const qr = jsQR(rgba.data, rgba.width, rgba.height);
  return qr?.data ?? undefined;
}

const truncate = (text: string): string => (text.length > 64 ? `${text.slice(0, 64)}…` : text);

export const qrCode: CheckDefinition = {
  ...meta,
  title: "QR codes",
  describe: "no decodable QR codes in textures or the thumbnail",
  explanation: "Scannable QR codes are rejected — their target can change after review.",
  fix: "Remove the QR code from the texture or thumbnail — QR targets can change after review, so they're rejected outright.",
  details: "Decodes every texture and the thumbnail to pixels and runs a QR detector over them — any readable code fails.",
  measure: (ctx) => {
    let images = 0;
    for (const model of ctx.models) images += model.doc.getRoot().listTextures().length;
    if (ctx.files.has(ctx.item.thumbnailPath ?? "thumbnail.png")) images++;
    return `${images} image${images === 1 ? "" : "s"} scanned`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const report = (message: string, where: string, decoded: string): void => {
      findings.push(finding(meta, "error", message, { where, data: { decoded: truncate(decoded) } }));
    };

    for (const model of ctx.models) {
      model.doc.getRoot().listTextures().forEach((tex, i) => {
        const img = tex.getImage();
        if (!img) return;
        const decoded = decodeQr(img);
        if (decoded === undefined) return;
        const name = tex.getName() || tex.getURI() || `texture #${i}`;
        report(
          `Texture "${name}" in "${model.mainFile}" contains a scannable QR code (it decodes to "${truncate(decoded)}") — QR codes aren't allowed in published content. Remove it from the texture.`,
          `"${model.mainFile}" › ${name}`,
          decoded
        );
      });
    }

    const thumbnailPath = ctx.item.thumbnailPath ?? "thumbnail.png";
    const thumbnail = ctx.files.get(thumbnailPath);
    if (thumbnail) {
      const decoded = decodeQr(thumbnail);
      if (decoded !== undefined) {
        report(
          `The thumbnail "${thumbnailPath}" contains a scannable QR code (it decodes to "${truncate(decoded)}") — QR codes aren't allowed in published content. Remove it from the image.`,
          thumbnailPath,
          decoded
        );
      }
    }

    return findings;
  }
};
