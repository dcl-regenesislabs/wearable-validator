import { BodyShape } from "@dcl/schemas";
import { imageSize } from "image-size";
import { countedMaterials, isJpegBytes, isPngBytes, jpegPrecision } from "./checks/model-materials.js";
import { computeAabb, formatDimensions, countTriangles, listJointNames } from "./gltf.js";
import type { CheckContext } from "./types.js";

const mb = (bytes: number): string => `${Math.round((bytes / 1048576) * 100) / 100} MB`;

function totalBytes(ctx: CheckContext): number {
  let total = 0;
  for (const bytes of ctx.files.values()) total += bytes.length;
  return total;
}

function textureSizes(ctx: CheckContext): [number, number][] {
  const sizes: [number, number][] = [];
  for (const model of ctx.models) {
    for (const texture of model.doc.getRoot().listTextures()) {
      const size = texture.getSize();
      if (size) sizes.push([size[0], size[1]]);
    }
  }
  return sizes;
}

function maxClipSeconds(ctx: CheckContext): number {
  let max = 0;
  for (const model of ctx.models) {
    for (const animation of model.doc.getRoot().listAnimations()) {
      for (const sampler of animation.listSamplers()) {
        const end = sampler.getInput()?.getMax([0])[0] ?? 0;
        if (end > max) max = end;
      }
    }
  }
  return max;
}

const audioExtensions = [".mp3", ".ogg", ".wav", ".aac", ".m4a", ".flac"];

/**
 * What the item actually measures, per check — shown beside the limit so a
 * passing check is never a black box. Read-only over the already-parsed
 * context; a missing entry just means nothing useful to display.
 */
export const measures: Record<string, (ctx: CheckContext) => string | undefined> = {
  "file-format": (ctx) => {
    const models = [...ctx.files.keys()].filter((p) => p.endsWith(".glb") || p.endsWith(".gltf"));
    return models.length > 0 ? `${models.length} model file${models.length > 1 ? "s" : ""}` : undefined;
  },
  "gltf-valid": (ctx) => (ctx.models.length > 0 ? `${ctx.models.length} GLB${ctx.models.length > 1 ? "s" : ""} parsed` : undefined),
  "metadata": (ctx) =>
    ctx.metadataMode === "entity" ? "entity metadata" : ctx.metadataMode === "builder" ? "builder manifest" : "no metadata",
  "representations": (ctx) => {
    const reps = ctx.item.representations ?? [];
    if (reps.length === 0) return undefined;
    const shapes = new Set(reps.flatMap((r) => r.bodyShapes.map((s) => (s === BodyShape.FEMALE ? "female" : s === BodyShape.MALE ? "male" : `unknown: ${s}`))));
    return `${shapes.size} body shape${shapes.size > 1 ? "s" : ""} (${[...shapes].join(", ")})`;
  },
  "file-size": (ctx) => `${mb(totalBytes(ctx))} total`,
  "thumbnail": (ctx) => {
    const bytes = ctx.files.get(ctx.item.thumbnailPath ?? "thumbnail.png");
    if (!bytes) return undefined;
    try {
      const { width, height } = imageSize(bytes);
      return `${width}×${height} · ${mb(bytes.length)}`;
    } catch {
      return `${mb(bytes.length)}`;
    }
  },
  "name-description": (ctx) => {
    const parts: string[] = [];
    if (ctx.item.name !== undefined) parts.push(`name ${ctx.item.name.length}`);
    if (ctx.item.description !== undefined) parts.push(`description ${ctx.item.description.length}`);
    parts.push(`${ctx.item.tags?.length ?? 0} tags`);
    return parts.join(" · ");
  },
  "category": (ctx) => ctx.category,
  "content-integrity": (ctx) => (ctx.content ? `${ctx.content.length} files hashed` : undefined),
  "gltf-hygiene": (ctx) => {
    const extensions = new Set<string>();
    for (const model of ctx.models) {
      const used = model.json.extensionsUsed;
      if (Array.isArray(used)) for (const ext of used as string[]) extensions.add(ext);
    }
    return `${extensions.size} extension${extensions.size === 1 ? "" : "s"} used`;
  },
  "smart-wearable": (ctx) => (ctx.emptyFiles.length > 0 ? `${ctx.emptyFiles.length} empty files` : undefined),

  "triangle-count": (ctx) => {
    const counts = ctx.models.map((m) => countTriangles(m.doc).total);
    if (counts.length === 0) return undefined;
    return `${Math.max(...counts).toLocaleString("en")} tris`;
  },
  "texture-count": (ctx) => {
    let images = 0;
    for (const model of ctx.models) images = Math.max(images, model.doc.getRoot().listTextures().length);
    return `${images} texture${images === 1 ? "" : "s"}`;
  },
  "texture-size": (ctx) => {
    const sizes = textureSizes(ctx);
    if (sizes.length === 0) return "no textures";
    const largest = sizes.reduce((a, b) => (b[0] * b[1] > a[0] * a[1] ? b : a));
    return `largest ${largest[0]}×${largest[1]}`;
  },
  "texture-format": (ctx) => {
    const formats = new Set<string>();
    for (const model of ctx.models) {
      for (const texture of model.doc.getRoot().listTextures()) {
        const bytes = texture.getImage();
        if (!bytes) formats.add("Image bytes unavailable");
        else if (isPngBytes(bytes)) formats.add(`PNG · ${bytes[24]}-bit`);
        else if (isJpegBytes(bytes)) {
          const depth = jpegPrecision(bytes);
          formats.add(`JPEG · ${depth === undefined ? "unknown bit depth" : `${depth}-bit`}`);
        } else formats.add(texture.getMimeType() || "Unknown format");
      }
    }
    return formats.size > 0 ? [...formats].join(" / ") : "No embedded textures";
  },
  "texture-maps": (ctx) => {
    const slots = new Set<string>();
    for (const model of ctx.models) {
      for (const material of model.doc.getRoot().listMaterials()) {
        if (material.getBaseColorTexture()) slots.add("base color");
        if (material.getEmissiveTexture()) slots.add("emission");
        if (material.getNormalTexture()) slots.add("normal");
        if (material.getMetallicRoughnessTexture()) slots.add("metallic-roughness");
        if (material.getOcclusionTexture()) slots.add("occlusion");
      }
    }
    return slots.size > 0 ? [...slots].join(" · ") : "untextured";
  },
  "material-count": (ctx) => {
    const count = Math.max(0, ...ctx.models.map(model => countedMaterials(model.doc).filter(material => material.getName() !== ctx.manifest.materials.avatarSkinMat).length));
    return `${count} material${count === 1 ? "" : "s"}`;
  },
  "material-names": (ctx) => {
    for (const model of ctx.models) {
      for (const material of model.doc.getRoot().listMaterials()) {
        if (material.getName() === ctx.manifest.materials.avatarSkinMat) return `has ${ctx.manifest.materials.avatarSkinMat}`;
      }
    }
    return `no ${ctx.manifest.materials.avatarSkinMat}`;
  },
  "bounding-box": (ctx) => {
    const bounds = ctx.models.flatMap(model => {
      const box = computeAabb(model.doc);
      return box ? [{ file: model.mainFile, value: formatDimensions(box) }] : [];
    });
    if (bounds.length === 1) return bounds[0].value;
    return bounds.length > 0 ? bounds.map(box => `${box.file}: ${box.value}`).join(" / ") : undefined;
  },
  "skeleton": (ctx) => {
    const joints = new Set(ctx.models.flatMap((m) => listJointNames(m.doc)));
    return joints.size > 0 ? `${joints.size} joints` : "not skinned";
  },
  "bone-weights": (ctx) => {
    const skinned = ctx.models.some((m) => m.doc.getRoot().listSkins().length > 0);
    return skinned ? "skinned" : "not skinned";
  },
  "hides-replaces": (ctx) => `hides ${ctx.item.hides?.length ?? 0} · replaces ${ctx.item.replaces?.length ?? 0}`,
  "static-mesh": (ctx) => {
    let clips = 0;
    let morphs = 0;
    for (const model of ctx.models) {
      clips += model.doc.getRoot().listAnimations().length;
      for (const mesh of model.doc.getRoot().listMeshes()) {
        if (mesh.listPrimitives().some((p) => p.listTargets().length > 0)) morphs++;
      }
    }
    return `${clips} animation${clips === 1 ? "" : "s"} · ${morphs} shape key${morphs === 1 ? "" : "s"}`;
  },
  "spring-bones": (ctx) => {
    const token = ctx.manifest.skeleton.springBoneToken;
    const joints = new Set(ctx.models.flatMap((m) => listJointNames(m.doc)));
    const springs = [...joints].filter((j) => j.toLowerCase().includes(token)).length;
    return `${springs} spring bone${springs === 1 ? "" : "s"}`;
  },

  "duration": (ctx) => {
    const seconds = maxClipSeconds(ctx);
    return seconds > 0 ? `${Math.round(seconds * 100) / 100} s` : undefined;
  },
  "animation-clips": (ctx) => {
    const names = ctx.models.flatMap((m) => m.doc.getRoot().listAnimations().map((a) => a.getName() || "(unnamed)"));
    return names.length > 0 ? `${names.length}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}` : "no clips";
  },
  "bone-targets": (ctx) => {
    let channels = 0;
    for (const model of ctx.models) for (const a of model.doc.getRoot().listAnimations()) channels += a.listChannels().length;
    return `${channels} channels`;
  },
  "loop-seam": (ctx) => (ctx.item.loop === undefined ? undefined : ctx.item.loop ? "loops" : "plays once"),
  "clip-names": (ctx) => {
    const names = ctx.models.flatMap((m) => m.doc.getRoot().listAnimations().map((a) => a.getName() || "(unnamed)"));
    return names.length > 0 ? names.slice(0, 2).join(", ") + (names.length > 2 ? "…" : "") : undefined;
  },
  "audio": (ctx) => {
    let count = 0;
    let bytes = 0;
    for (const [path, data] of ctx.files) {
      if (audioExtensions.some((ext) => path.toLowerCase().endsWith(ext))) {
        count++;
        bytes += data.length;
      }
    }
    return count > 0 ? `${count} file${count === 1 ? "" : "s"} · ${mb(bytes)}` : "no audio";
  },
  "social-outcomes": (ctx) => {
    const outcomes = ctx.item.emoteData?.outcomes;
    return outcomes ? `${outcomes.length} outcomes` : undefined;
  },
  "qr-code": (ctx) => {
    let images = 0;
    for (const model of ctx.models) images += model.doc.getRoot().listTextures().length;
    if (ctx.files.has(ctx.item.thumbnailPath ?? "thumbnail.png")) images++;
    return `${images} image${images === 1 ? "" : "s"} scanned`;
  }
};
