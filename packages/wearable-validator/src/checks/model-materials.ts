import type { Document, Material, Texture } from "@gltf-transform/core";
import { imageSize } from "image-size";
import { isColliderNode } from "../gltf.js";
import { docsUrl, type CheckContext, type CheckDefinition, type Finding, type Severity } from "../types.js";

const wearableOnly = (ctx: CheckContext): true | string =>
  ctx.itemType === "wearable" ? true : "wearable material rules don't apply to emotes (prop budgets are covered by the props check, E-07)";

function finding(check: string, rule: string, severity: Severity, message: string, extra?: Partial<Finding>): Finding {
  return { check, group: "model", rule, severity, message, docs: docsUrl(check), ...extra };
}

/** Materials that count toward limits: used by primitives of meshes on non-collider nodes. */
function countedMaterials(doc: Document): Material[] {
  const set = new Set<Material>();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || isColliderNode(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat) set.add(mat);
    }
  }
  return [...set];
}

/** Mesh names on non-collider nodes (unique). */
function countedMeshNames(doc: Document): string[] {
  const names = new Set<string>();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || isColliderNode(node)) continue;
    names.add(mesh.getName());
  }
  return [...names];
}

const TEXTURE_SLOTS: { slot: string; get: (m: Material) => Texture | null }[] = [
  { slot: "baseColorTexture", get: (m) => m.getBaseColorTexture() },
  { slot: "emissiveTexture", get: (m) => m.getEmissiveTexture() },
  { slot: "normalTexture", get: (m) => m.getNormalTexture() },
  { slot: "metallicRoughnessTexture", get: (m) => m.getMetallicRoughnessTexture() },
  { slot: "occlusionTexture", get: (m) => m.getOcclusionTexture() }
];

function textureName(tex: Texture, index: number): string {
  return tex.getName() || tex.getURI() || `texture #${index}`;
}

export function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length > 25 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function safeDims(bytes: Uint8Array): { width: number; height: number } | undefined {
  try {
    const { width, height } = imageSize(bytes);
    return { width, height };
  } catch {
    return undefined; // undecodable — texture-format reports it
  }
}

/** PNG alpha: IHDR color type 4 (gray+alpha) / 6 (RGBA), or palette (3) with a tRNS chunk. */
function pngHasAlpha(bytes: Uint8Array): boolean {
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
function jpegPrecision(bytes: Uint8Array): number | undefined {
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

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

function dimensionFindings(where: string, dims: { width: number; height: number }, maxSize: number, facial: boolean): Finding[] {
  const findings: Finding[] = [];
  const measured = `${dims.width}×${dims.height}`;
  if (dims.width > maxSize || dims.height > maxSize) {
    findings.push(
      finding("texture-size", "M-03", "error",
        `${where} is ${measured}; the maximum ${facial ? "facial-feature texture" : "texture"} size is ${maxSize}×${maxSize}. Resize it to ${maxSize}×${maxSize} or smaller.`,
        { where, measured, limit: `${maxSize}×${maxSize}` })
    );
  }
  if (dims.width !== dims.height) {
    findings.push(
      finding("texture-size", "M-03", "error",
        `${where} is ${measured} — textures must be square. Re-export it with equal width and height.`,
        { where, measured })
    );
  } else if (!isPowerOfTwo(dims.width)) {
    findings.push(
      finding("texture-size", "M-03", "warning",
        `${where} is ${measured}, which is not a power of two — GPUs handle 256×256 or 512×512 far better. Resize to the nearest power of two.`,
        { where, measured })
    );
  }
  return findings;
}

const textureCount: CheckDefinition = {
  name: "texture-count",
  group: "model",
  rule: "M-02",
  title: "Texture count",
  describe: "unique texture images stay within the per-category limit (2 by default, 5 for skins)",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const limit = ctx.category === "skin" ? ctx.manifest.textures.skin : ctx.manifest.textures.default;
    for (const model of ctx.models) {
      const textures = new Set<Texture>();
      for (const mat of countedMaterials(model.doc)) {
        if (mat.getName() === ctx.manifest.materials.avatarSkinMat) continue;
        for (const { get } of TEXTURE_SLOTS) {
          const tex = get(mat);
          if (tex) textures.add(tex);
        }
      }
      if (textures.size > limit) {
        findings.push(
          finding("texture-count", "M-02", "error",
            `"${model.mainFile}" references ${textures.size} texture images; the limit is ${limit}${ctx.category === "skin" ? " for skins" : ""}. Merge the images into a texture atlas so the model uses at most ${limit}.`,
            {
              where: model.mainFile,
              measured: textures.size,
              limit,
              data: { textures: [...textures].map((t, i) => textureName(t, i)) }
            })
        );
      }
    }
    return findings;
  }
};

const textureSize: CheckDefinition = {
  name: "texture-size",
  group: "model",
  rule: "M-03",
  title: "Texture size",
  describe: "textures are square, within the size limit (512², facial features 256² with alpha), and warn when not power-of-two",
  categoryDependent: true,
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const facial = ctx.category !== undefined && ctx.manifest.facialCategories.includes(ctx.category);
    const maxSize = facial ? ctx.manifest.textures.facialMaxSize : ctx.manifest.textures.maxSize;

    if (facial) {
      const skip = new Set([ctx.item.thumbnailPath ?? "thumbnail.png", ctx.item.rarityImagePath ?? "image.png"]);
      for (const [path, bytes] of ctx.files) {
        if (skip.has(path) || !isPngBytes(bytes)) continue;
        const dims = safeDims(bytes);
        if (!dims) continue;
        findings.push(...dimensionFindings(`"${path}"`, dims, maxSize, true));
        if (!pngHasAlpha(bytes)) {
          findings.push(
            finding("texture-size", "M-03", "error",
              `"${path}" has no alpha channel — facial-feature textures must be PNGs with transparency so they can be masked onto the face. Re-export it as RGBA.`,
              { where: path })
          );
        }
      }
    }

    for (const model of ctx.models) {
      model.doc.getRoot().listTextures().forEach((tex, i) => {
        const img = tex.getImage();
        if (!img) return;
        const dims = safeDims(img);
        if (!dims) return;
        const where = `"${model.mainFile}" › ${textureName(tex, i)}`;
        findings.push(...dimensionFindings(where, dims, maxSize, facial));
      });
    }
    return findings;
  }
};

const textureFormat: CheckDefinition = {
  name: "texture-format",
  group: "model",
  rule: "M-04",
  title: "Texture format",
  describe: "embedded texture images are PNG or JPEG with 8-bit channels",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      model.doc.getRoot().listTextures().forEach((tex, i) => {
        const img = tex.getImage();
        if (!img) return;
        const where = `"${model.mainFile}" › ${textureName(tex, i)}`;
        if (isPngBytes(img)) {
          const depth = img[24];
          if (depth !== 8) {
            findings.push(
              finding("texture-format", "M-04", "error",
                `${where} is a ${depth}-bit PNG; textures must use 8 bits per channel. Re-export it as an 8-bit PNG.`,
                { where, measured: `${depth}-bit`, limit: "8-bit" })
            );
          }
        } else if (isJpegBytes(img)) {
          const precision = jpegPrecision(img);
          if (precision !== undefined && precision !== 8) {
            findings.push(
              finding("texture-format", "M-04", "error",
                `${where} is a ${precision}-bit JPEG; textures must use 8 bits per channel. Re-export it as a standard 8-bit JPEG.`,
                { where, measured: `${precision}-bit`, limit: "8-bit" })
            );
          }
        } else {
          const mime = tex.getMimeType() || "an unknown format";
          findings.push(
            finding("texture-format", "M-04", "error",
              `${where} is ${mime} — embedded textures must be PNG or JPEG. Convert the image and re-export the GLB.`,
              { where, measured: mime, limit: "image/png or image/jpeg" })
          );
        }
      });
    }
    return findings;
  }
};

const FORBIDDEN_MAPS: { label: string; prop: string; get: (m: Material) => Texture | null }[] = [
  { label: "normal map", prop: "normalTexture", get: (m) => m.getNormalTexture() },
  { label: "metallic/roughness map", prop: "metallicRoughnessTexture", get: (m) => m.getMetallicRoughnessTexture() },
  { label: "occlusion map", prop: "occlusionTexture", get: (m) => m.getOcclusionTexture() }
];

const textureMaps: CheckDefinition = {
  name: "texture-maps",
  group: "model",
  rule: "M-05",
  title: "Texture maps",
  describe: "materials use only base color, emissive and alpha — no normal, metallic/roughness or occlusion maps",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      for (const mat of countedMaterials(model.doc)) {
        for (const { label, prop, get } of FORBIDDEN_MAPS) {
          if (!get(mat)) continue;
          findings.push(
            finding("texture-maps", "M-05", "error",
              `Material "${mat.getName()}" in "${model.mainFile}" uses a ${label} — Decentraland's avatar shader only supports base color, emissive and alpha. Bake the detail into the base color texture and remove the ${label}.`,
              { where: `"${model.mainFile}" › ${mat.getName()}`, data: { map: prop } })
          );
        }
      }
    }
    return findings;
  }
};

const materialCount: CheckDefinition = {
  name: "material-count",
  group: "model",
  rule: "M-06",
  title: "Material count",
  describe: "materials stay within the per-category limit (2 by default, 5 for skins), excluding AvatarSkin_MAT",
  categoryDependent: true,
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const limit = ctx.category === "skin" ? ctx.manifest.materials.skin : ctx.manifest.materials.default;
    for (const model of ctx.models) {
      const mats = countedMaterials(model.doc).filter((m) => m.getName() !== ctx.manifest.materials.avatarSkinMat);
      if (mats.length > limit) {
        findings.push(
          finding("material-count", "M-06", "error",
            `"${model.mainFile}" uses ${mats.length} materials; the limit is ${limit}${ctx.category === "skin" ? " for skins" : ""} (${ctx.manifest.materials.avatarSkinMat} excluded). Merge meshes so they share at most ${limit} materials.`,
            { where: model.mainFile, measured: mats.length, limit, data: { materials: mats.map((m) => m.getName()) } })
        );
      }
    }
    return findings;
  }
};

const materialNames: CheckDefinition = {
  name: "material-names",
  group: "model",
  rule: "M-07",
  title: "Material & mesh names",
  describe: "skin items include an AvatarSkin_MAT material; mesh names don't use reserved facial-feature tokens",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const skinMat = ctx.manifest.materials.avatarSkinMat;
    const facial = ctx.category !== undefined && ctx.manifest.facialCategories.includes(ctx.category);
    for (const model of ctx.models) {
      if (ctx.category === "skin" && !countedMaterials(model.doc).some((m) => m.getName() === skinMat)) {
        findings.push(
          finding("material-names", "M-07", "warning",
            `"${model.mainFile}" has no material named exactly "${skinMat}" — skin items need it so the engine can tint the body with the player's skin color. Rename the body material to "${skinMat}".`,
            { where: model.mainFile, data: { expected: skinMat } })
        );
      }
      if (!facial) {
        for (const meshName of countedMeshNames(model.doc)) {
          const lower = meshName.toLowerCase();
          for (const pattern of ctx.manifest.materials.forbiddenMeshNamePatterns) {
            if (!lower.includes(pattern.toLowerCase())) continue;
            findings.push(
              finding("material-names", "M-07", "error",
                `Mesh "${meshName}" in "${model.mainFile}" contains the reserved token "${pattern}", which is reserved for facial-feature wearables. Rename the mesh.`,
                { where: `"${model.mainFile}" › ${meshName}`, data: { pattern } })
            );
          }
        }
      }
    }
    return findings;
  }
};

export const modelMaterialChecks: CheckDefinition[] = [
  textureCount,
  textureSize,
  textureFormat,
  textureMaps,
  materialCount,
  materialNames
];
