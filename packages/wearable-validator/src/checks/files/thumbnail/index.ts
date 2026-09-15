/** S-06 Thumbnail — the marketplace and backpack composite the preview over their own background, so it must be a transparent PNG within size limits. */
import { mb } from "../../../logic/bytes.js";
import { decodePngSafe, imageDimensions, isPngBytes } from "../../../logic/images.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding, type Severity } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "thumbnail", group: "files", rule: "S-06", docs: `${UPLOADING}#custom-thumbnails` };

export const thumbnail: CheckDefinition = {
  ...meta,
  title: "Thumbnail",
  describe: "PNG, ≤1 MB, ≤1024px, transparent background; 256×256 recommended",
  explanation: "The thumbnail is the preview image shown in the marketplace and backpack: a square PNG with a transparent background.",
  fix: "Export a 256×256 PNG with a transparent background (in Blender: render with Film → Transparent; in Photoshop/GIMP: delete the background layer before saving).",
  details: "Decodes the PNG: format, ≤1 MB and ≤1024×1024 are hard limits; squareness, the 256×256 recommendation and background transparency (alpha scan) are warnings.",
  measure: (ctx) => {
    const bytes = ctx.files.get(ctx.item.thumbnailPath ?? "thumbnail.png");
    if (!bytes) return undefined;
    const dims = imageDimensions(bytes);
    return dims ? `${dims.width}×${dims.height} · ${mb(bytes.length)} MB` : `${mb(bytes.length)} MB`;
  },
  appliesTo: (ctx) => (ctx.inputKind === "glb" || ctx.inputKind === "png-set" ? "bare inputs carry no thumbnail" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const path = ctx.item.thumbnailPath ?? "thumbnail.png";
    const f = (severity: Severity, message: string, extra?: Partial<Finding>) => findings.push(finding(meta, severity, message, { where: path, ...extra }));
    const bytes = ctx.files.get(path);
    if (!bytes) {
      f("error", `Thumbnail "${path}" not found — add a square transparent PNG (256×256 recommended).`);
      return findings;
    }
    if (!isPngBytes(bytes)) {
      f("error", `Thumbnail "${path}" is not a PNG — export it as a PNG with transparency.`);
      return findings;
    }
    const { thumbnailBytes, thumbnailMaxSize, thumbnailRecommendedSize } = ctx.manifest.fileSize;
    if (bytes.length > thumbnailBytes) {
      f("error", `Thumbnail is ${mb(bytes.length)} MB — the maximum is ${mb(thumbnailBytes)} MB. Export at 256×256 to stay well under it.`, {
        measured: bytes.length,
        limit: thumbnailBytes
      });
    }
    const img = decodePngSafe(bytes);
    if (!img) {
      f("error", `Thumbnail "${path}" could not be decoded — re-export it as a standard PNG.`);
      return findings;
    }
    const dims = `${img.width}×${img.height}`;
    if (img.width > thumbnailMaxSize || img.height > thumbnailMaxSize) {
      f("error", `Thumbnail is ${dims} — no dimension may exceed ${thumbnailMaxSize}px.`, { measured: dims, limit: `${thumbnailMaxSize}×${thumbnailMaxSize}` });
    } else if (img.width !== img.height || img.width !== thumbnailRecommendedSize) {
      f("warning", `Thumbnail is ${dims} — a square ${thumbnailRecommendedSize}×${thumbnailRecommendedSize} PNG is recommended.`, {
        measured: dims,
        limit: `${thumbnailRecommendedSize}×${thumbnailRecommendedSize}`
      });
    }

    const hasAlphaChannel = img.channels === 4 || img.channels === 2;
    if (!hasAlphaChannel) {
      f("warning", "Thumbnail has no alpha channel — the background should be transparent. Export as RGBA PNG.");
    } else {
      const { alphaThreshold, minTransparentPixelRatio } = ctx.manifest.thumbnail;
      const scale = img.depth === 16 ? 257 : 1;
      let transparent = 0;
      const pixels = img.width * img.height;
      for (let i = 0; i < pixels; i++) {
        const alpha = img.data[(i + 1) * img.channels - 1] / scale;
        if (alpha < alphaThreshold) transparent++;
      }
      const ratio = pixels === 0 ? 0 : transparent / pixels;
      if (ratio < minTransparentPixelRatio) {
        f(
          "warning",
          `Thumbnail background does not look transparent (${(ratio * 100).toFixed(2)}% transparent pixels; at least ${minTransparentPixelRatio * 100}% expected) — remove the background.`,
          { measured: ratio, limit: minTransparentPixelRatio }
        );
      }
    }
    return findings;
  }
};
