import { effectiveTriangleLimit, manifest } from "./manifest/index.js";

const mb = (bytes: number): string => `${Math.round((bytes / 1048576) * 10) / 10} MB`;

/**
 * The enforced value(s) per check, formatted for display — always derived from
 * the manifest so the UI shows what is actually validated. Category-aware
 * where limits depend on the slot; undefined for structural checks with no
 * number to show.
 */
export function limitFor(check: string, category?: string, hides?: string[]): string | undefined {
  const m = manifest;
  const facial = category !== undefined && m.facialCategories.includes(category);
  switch (check) {
    case "representations":
      return "≥ 1 body shape";
    case "file-size": {
      const total = category === "skin" ? m.fileSize.skinBytes : m.fileSize.wearableBytes;
      return `≤ ${mb(total)} total`;
    }
    case "thumbnail":
      return `square PNG · ≤ ${m.fileSize.thumbnailMaxSize}px · ≤ ${mb(m.fileSize.thumbnailBytes)}`;
    case "name-description":
      return `name ≤ ${m.text.nameMax} · description ≤ ${m.text.descriptionMax} · tags ≤ ${m.text.tagsMax}`;
    case "gltf-hygiene":
      return "no cameras · no lights";
    case "smart-wearable":
      return `video ≤ ${mb(m.fileSize.smartWearableVideoBytes)}`;
    case "triangle-count": {
      if (category) return `≤ ${effectiveTriangleLimit(category, hides).toLocaleString("en")} tris (${category})`;
      const values = Object.values(m.triangles.perCategory);
      return `${Math.min(...values).toLocaleString("en")}–${Math.max(...values).toLocaleString("en")} tris by category`;
    }
    case "texture-count":
      return category === "skin" ? `≤ ${m.textures.skin} textures (skin)` : `≤ ${m.textures.default} textures`;
    case "texture-size": {
      const max = facial ? m.textures.facialMaxSize : m.textures.maxSize;
      return `≤ ${max}×${max} · square`;
    }
    case "texture-format":
      return "PNG / JPEG · 8-bit";
    case "texture-maps":
      return "base color · emission · alpha";
    case "material-count":
      return category === "skin" ? `≤ ${m.materials.skin} materials (skin)` : `≤ ${m.materials.default} materials`;
    case "material-names":
      return m.materials.avatarSkinMat;
    case "bounding-box":
      return `≤ ${m.boundingBox.width} × ${m.boundingBox.height} × ${m.boundingBox.depth} m`;
    case "skeleton":
      return "62 canonical bones";
    case "bone-weights":
      return `≤ ${m.skeleton.maxInfluences} bones/vertex · Σ = 1`;
    case "hands-geometry":
      return `≥ ${m.hands.minHandWeightRatio * 100}% weight on hand bones`;
    case "static-mesh":
      return "0 animations · 0 shape keys";
    case "spring-bones":
      return `≤ ${m.skeleton.maxSpringBones} spring bones`;
    case "duration":
      return `≤ ${m.emote.maxDurationSeconds} s (${m.emote.maxFrames} frames @ ${m.emote.expectedFps} fps)`;
    case "animation-clips":
      return `≤ ${m.emote.maxClipsWithProps} clips (_Avatar / _Prop)`;
    case "bone-targets":
      return "avatar bones only";
    case "loop-seam":
      return "first pose = last pose";
    case "root-motion":
      return `≤ ${m.emote.rootMotion.horizontalErrorMeters} m horizontal · ≤ ${m.emote.rootMotion.verticalErrorMeters} m vertical`;
    case "clip-names":
      return "Capitalized_Words";
    case "props":
      return `≤ ${m.emote.propMaxTriangles.toLocaleString("en")} tris · ${m.emote.propMaxMaterials} materials · ${m.emote.propMaxTextures} textures`;
    case "audio":
      return `mp3 / ogg · ≤ ${mb(m.fileSize.audioBytes)}`;
    case "social-outcomes":
      return `≤ ${m.emote.maxSocialOutcomes} outcomes`;
    case "qr-code":
      return "0 QR codes";
    default:
      return undefined;
  }
}
