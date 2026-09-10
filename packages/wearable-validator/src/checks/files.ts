import { BodyShape, EmoteCategory, Rarity, RequiredPermission, WearableCategory } from "@dcl/schemas";
import { metadataSchemaFindings } from "../metadata-schema.js";
import { contentHash } from "../content-hash.js";
import { decode as decodePng } from "fast-png";
import { isGlb, readGlbJsonChunk } from "../gltf.js";
import { docsUrl, type CheckContext, type CheckDefinition, type Finding, type Severity } from "../types.js";

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const MANIFEST_FILE_NAMES = ["wearable.json", "emote.json"];

// Object.values also yields the namespace's schema/validate members — keep only the enum strings.
const WEARABLE_CATEGORY_VALUES: Set<string> = new Set(
  Object.values(WearableCategory).filter((v): v is WearableCategory => typeof v === "string")
);
const PERMISSION_VALUES: Set<string> = new Set(Object.values(RequiredPermission));

function finding(check: string, rule: string, severity: Severity, message: string, extra?: Partial<Finding>): Finding {
  return { check, group: "files", severity, message, rule, docs: docsUrl(check), ...extra };
}

const mb = (n: number): number => Math.round((n / 1048576) * 100) / 100;

function isFacial(ctx: CheckContext): boolean {
  return ctx.category !== undefined && ctx.manifest.facialCategories.includes(ctx.category);
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Model-file candidates: parsed models ∪ representation mainFiles present ∪ (fallback) files ending .glb/.gltf. */
function modelFileCandidates(ctx: CheckContext): string[] {
  const candidates = new Set<string>();
  for (const model of ctx.models) candidates.add(model.mainFile);
  for (const rep of ctx.item.representations ?? []) {
    if (ctx.files.has(rep.mainFile)) candidates.add(rep.mainFile);
  }
  if (candidates.size === 0) {
    for (const path of ctx.files.keys()) {
      if (path.endsWith(".glb") || path.endsWith(".gltf")) candidates.add(path);
    }
  }
  return [...candidates].sort();
}

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  depth: number;
  data: Uint8Array | Uint16Array;
}

function decodePngSafe(bytes: Uint8Array): DecodedPng | undefined {
  try {
    const img = decodePng(bytes);
    // fast-png may hand back a Uint8ClampedArray — view it as Uint8Array (same buffer, same indexing).
    const data = img.data instanceof Uint16Array ? img.data : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return { width: img.width, height: img.height, channels: img.channels, depth: img.depth, data };
  } catch {
    return undefined;
  }
}

// ── S-01 file-format ────────────────────────────────────────────────────

function facialPngFindings(ctx: CheckContext, path: string): Finding[] {
  const out: Finding[] = [];
  const f = (severity: Severity, message: string, extra?: Partial<Finding>) =>
    out.push(finding("file-format", "S-01", severity, message, { where: path, ...extra }));
  const bytes = ctx.files.get(path);
  if (!bytes) return out; // representations (S-04) reports missing files
  if (!path.endsWith(".png") || !isPng(bytes)) {
    f("error", `"${path}" must be a PNG — facial-feature wearables (${ctx.manifest.facialCategories.join("/")}) are texture-only PNG sets.`);
    return out;
  }
  const img = decodePngSafe(bytes);
  if (!img) {
    f("error", `"${path}" is not a decodable PNG — re-export it as a standard PNG file.`);
    return out;
  }
  const max = ctx.manifest.textures.facialMaxSize;
  if (img.width !== img.height) {
    f("error", `"${path}" is ${img.width}×${img.height} — facial-feature textures must be square.`, { measured: `${img.width}×${img.height}` });
  }
  if (img.width > max || img.height > max) {
    f("error", `"${path}" is ${img.width}×${img.height} — facial-feature textures must be at most ${max}×${max}.`, {
      measured: `${img.width}×${img.height}`,
      limit: `${max}×${max}`
    });
  }
  if (img.channels !== 4 && img.channels !== 2) {
    f("error", `"${path}" has no alpha channel — facial-feature textures need transparency. Export as RGBA PNG.`);
  }
  return out;
}

const fileFormat: CheckDefinition = {
  name: "file-format",
  group: "files",
  rule: "S-01",
  title: "File format",
  describe: ".glb for models; facial features are square PNG sets with alpha",
  run: (ctx) => {
    const findings: Finding[] = [];
    if (isFacial(ctx)) {
      const paths = new Set<string>();
      const reps = ctx.item.representations ?? [];
      if (reps.length > 0) {
        for (const rep of reps) {
          paths.add(rep.mainFile);
          for (const content of rep.contents) if (content.endsWith(".png")) paths.add(content);
        }
      } else {
        for (const path of ctx.files.keys()) if (path.endsWith(".png")) paths.add(path);
      }
      // The thumbnail and rarity image have their own rules (S-06 / S-05).
      paths.delete(ctx.item.thumbnailPath ?? "thumbnail.png");
      paths.delete(ctx.item.rarityImagePath ?? "image.png");
      for (const path of [...paths].sort()) findings.push(...facialPngFindings(ctx, path));
      return findings;
    }

    const candidates = modelFileCandidates(ctx);
    if (candidates.length === 0) {
      findings.push(finding("file-format", "S-01", "error", "No model file found — the item needs a .glb model (glTF 2.0 binary)."));
      return findings;
    }
    for (const path of candidates) {
      const bytes = ctx.files.get(path);
      if (path.endsWith(".gltf")) {
        findings.push(
          finding("file-format", "S-01", "error", `"${path}" is a .gltf — only self-contained .glb (glTF 2.0 binary) is supported. Re-export as .glb.`, { where: path })
        );
        continue;
      }
      if (!path.endsWith(".glb")) {
        findings.push(finding("file-format", "S-01", "error", `Model file "${path}" must be a .glb (glTF 2.0 binary).`, { where: path }));
        continue;
      }
      if (bytes && !isGlb(bytes)) {
        findings.push(
          finding("file-format", "S-01", "error", `"${path}" is named .glb but its content is not GLB binary — re-export the model as glTF 2.0 binary.`, { where: path })
        );
      }
    }
    return findings;
  }
};

// ── S-02 gltf-valid ─────────────────────────────────────────────────────
// TODO(S-02): full glTF spec conformance via @dcl/gltf-validator-ts (severity policy in
// manifest.gltf) — this covers GLB container integrity + loader parse errors only.

function glbContainerFindings(path: string, bytes: Uint8Array): Finding[] {
  const out: Finding[] = [];
  const err = (message: string) => out.push(finding("gltf-valid", "S-02", "error", message, { where: path }));
  if (bytes.length < 20) {
    err(`"${path}" is truncated (${bytes.length} bytes) — a GLB needs a 12-byte header plus a JSON chunk. Re-export the model.`);
    return out;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    err(`"${path}" does not start with the GLB magic bytes — the file is not a glTF 2.0 binary.`);
    return out;
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    err(`"${path}" declares glTF version ${version} — only glTF 2.0 is supported. Re-export with a current exporter.`);
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.length) {
    err(`"${path}" declares a length of ${declaredLength} bytes but the file is ${bytes.length} bytes — the file is corrupt or truncated. Re-export it.`);
  }
  let offset = 12;
  let first = true;
  while (offset + 8 <= bytes.length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    if (offset + 8 + chunkLength > bytes.length) {
      err(`"${path}" has a chunk at byte ${offset} that runs past the end of the file — the file is corrupt or truncated.`);
      return out;
    }
    if (first) {
      if (chunkType !== GLB_CHUNK_JSON) {
        err(`"${path}"'s first chunk is not the JSON chunk — the GLB container is malformed.`);
        return out;
      }
      try {
        JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + chunkLength)));
      } catch {
        err(`"${path}"'s JSON chunk is not valid JSON — the file is corrupt. Re-export the model.`);
      }
      first = false;
    }
    offset += 8 + chunkLength;
  }
  return out;
}

const gltfValid: CheckDefinition = {
  name: "gltf-valid",
  group: "files",
  rule: "S-02",
  title: "glTF validity",
  describe: "GLB container is well-formed and the model parses",
  appliesTo: (ctx) => (isFacial(ctx) ? "facial-feature wearables carry no GLB model" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const path of modelFileCandidates(ctx)) {
      const bytes = ctx.files.get(path);
      if (bytes && isGlb(bytes)) findings.push(...glbContainerFindings(path, bytes));
    }
    if (ctx.parseError) {
      findings.push(finding("gltf-valid", "S-02", "error", `The model failed to parse: ${ctx.parseError}.`));
    }
    return findings;
  }
};

// ── S-03 metadata ───────────────────────────────────────────────────────

function divergentFields(ctx: CheckContext): string[] {
  const embedded = ctx.embeddedManifest;
  if (!embedded) return [];
  const item = ctx.item;
  const fields: string[] = [];
  const scalar = (name: string, a: string | undefined, b: string | undefined) => {
    if (a !== undefined && b !== undefined && a !== b) fields.push(name);
  };
  scalar("name", item.name, embedded.name);
  scalar("description", item.description, embedded.description);
  scalar("rarity", item.rarity, embedded.rarity);
  scalar("category", item.category ?? item.emoteData?.category, embedded.category ?? embedded.emoteData?.category);
  for (const key of ["tags", "hides", "replaces"] as const) {
    const a = item[key];
    const b = embedded[key];
    if (a && b && JSON.stringify(a) !== JSON.stringify(b)) fields.push(key);
  }
  return fields;
}

const metadata: CheckDefinition = {
  name: "metadata",
  group: "files",
  rule: "S-03",
  title: "Metadata",
  describe: "supplied item matches its platform schema; Builder manifests have required fields",
  appliesTo: (ctx) => (ctx.inputKind === "glb" || ctx.inputKind === "png-set" ? "bare inputs carry no metadata" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    if (ctx.metadataMode === "none") {
      findings.push(
        finding(
          "metadata",
          "S-03",
          "error",
          ctx.inputKind === "zip"
            ? "No wearable.json or emote.json found in the zip — export the item from the Builder so its metadata travels with it."
            : "No metadata provided — pass the entity metadata or include a wearable.json/emote.json in the files."
        )
      );
      return findings;
    }

    for (const name of MANIFEST_FILE_NAMES) {
      const bytes = ctx.files.get(name);
      if (!bytes) continue;
      try {
        JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        findings.push(finding("metadata", "S-03", "error", `"${name}" is not valid JSON — re-export the item from the Builder.`, { where: name }));
      }
    }

    if (ctx.metadataMode === "entity") findings.push(...metadataSchemaFindings(ctx.entityMetadata, ctx.itemType));

    if (ctx.metadataMode === "builder" && ctx.item.rarity !== undefined && !Rarity.validate(ctx.item.rarity)) {
      findings.push(finding("metadata", "S-03", "error", `Unknown rarity "${ctx.item.rarity}" — choose a valid item rarity in the Builder.`, { where: "rarity", measured: String(ctx.item.rarity) }));
    }
    if (typeof ctx.item.name !== "string" || !ctx.item.name.trim()) {
      findings.push(finding("metadata", "S-03", "error", "The item has no name — give it a name before publishing."));
    }
    const category = ctx.itemType === "emote" ? ctx.item.emoteData?.category ?? ctx.item.category : ctx.item.category;
    if (!category) {
      findings.push(finding("metadata", "S-03", "error", `The ${ctx.itemType} declares no category — set one in the item metadata.`));
    }

    if (ctx.metadataMode === "entity" && ctx.embeddedManifest) {
      const fields = divergentFields(ctx);
      if (fields.length > 0) {
        findings.push(
          finding(
            "metadata",
            "S-03",
            "warning",
            `The provided metadata and the zip's embedded manifest disagree on: ${fields.join(", ")}. The provided metadata was used; the embedded manifest was ignored.`,
            { data: { fields } }
          )
        );
      }
    }
    return findings;
  }
};

// ── S-04 representations ────────────────────────────────────────────────

const representations: CheckDefinition = {
  name: "representations",
  group: "files",
  rule: "S-04",
  title: "Representations",
  describe: "≥1 body-shape representation; mainFile and listed contents exist",
  appliesTo: (ctx) => {
    if (ctx.inputKind === "glb" || ctx.inputKind === "png-set") return "bare inputs carry no representations metadata";
    if (ctx.metadataMode === "none") return "no metadata (representations live in the item metadata)";
    return true;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const reps = ctx.item.representations ?? [];
    if (reps.length === 0) {
      findings.push(
        finding("representations", "S-04", "error", "The item declares no body-shape representation — it needs at least one (BaseMale and/or BaseFemale).")
      );
      return findings;
    }
    reps.forEach((rep, index) => {
      const where = rep.bodyShapes.join(", ") || `representation ${index + 1}`;
      if (rep.bodyShapes.length === 0) {
        findings.push(finding("representations", "S-04", "error", `Representation ${index + 1} lists no body shapes — every representation needs at least one.`, { where: `representation ${index + 1}` }));
      }
      for (const shape of rep.bodyShapes) {
        if (!BodyShape.validate(shape)) {
          findings.push(finding("representations", "S-04", "error", `Unknown body shape "${shape}" — use BaseMale or BaseFemale's full body-shape URN.`, { where, measured: String(shape), limit: `${BodyShape.MALE} or ${BodyShape.FEMALE}` }));
        }
      }
      if (!rep.contents.includes(rep.mainFile)) {
        findings.push(
          finding("representations", "S-04", "error", `Representation "${where}" has mainFile "${rep.mainFile}" but does not list it in its contents.`, { where })
        );
      }
      if (!ctx.files.has(rep.mainFile)) {
        findings.push(
          finding("representations", "S-04", "error", `Representation "${where}" points at "${rep.mainFile}" but that file is not in the item.`, { where })
        );
      }
      for (const content of rep.contents) {
        if (content !== rep.mainFile && !ctx.files.has(content)) {
          findings.push(
            finding("representations", "S-04", "error", `Representation "${where}" lists "${content}" in its contents but that file is not in the item.`, { where })
          );
        }
      }
    });
    return findings;
  }
};

// ── S-05 file-size ──────────────────────────────────────────────────────

const fileSize: CheckDefinition = {
  name: "file-size",
  group: "files",
  rule: "S-05",
  title: "File size",
  describe: "total size within the category limit (thumbnail + rarity image included)",
  categoryDependent: true,
  run: (ctx) => {
    const findings: Finding[] = [];
    const { fileSize: sizes } = ctx.manifest;
    const limit =
      ctx.itemType === "emote" ? sizes.emoteBytes : ctx.category === "skin" ? sizes.skinBytes : sizes.wearableBytes;
    const label = ctx.itemType === "emote" ? "an emote" : ctx.category === "skin" ? "a skin" : "a wearable";

    let total = 0;
    for (const bytes of ctx.files.values()) total += bytes.length;
    if (total > limit) {
      findings.push(
        finding(
          "file-size",
          "S-05",
          "error",
          `The item totals ${mb(total)} MB; the limit for ${label} is ${mb(limit)} MB — the thumbnail and rarity image count toward it (ADR-246). Reduce textures or geometry.`,
          { measured: total, limit, data: { includesThumbnailAndRarityImage: true } }
        )
      );
    }

    const modelLimit = limit - sizes.modelHeadroomBytes;
    for (const path of modelFileCandidates(ctx)) {
      const bytes = ctx.files.get(path);
      if (bytes && bytes.length > modelLimit) {
        findings.push(
          finding(
            "file-size",
            "S-05",
            "error",
            `The model "${path}" alone is ${mb(bytes.length)} MB; it must stay under ${mb(modelLimit)} MB to leave room for the thumbnail and rarity image.`,
            { where: path, measured: bytes.length, limit: modelLimit }
          )
        );
      }
    }
    return findings;
  }
};

// ── S-06 thumbnail ──────────────────────────────────────────────────────

const thumbnail: CheckDefinition = {
  name: "thumbnail",
  group: "files",
  rule: "S-06",
  title: "Thumbnail",
  describe: "PNG, ≤1 MB, ≤1024px, transparent background; 256×256 recommended",
  appliesTo: (ctx) => (ctx.inputKind === "glb" || ctx.inputKind === "png-set" ? "bare inputs carry no thumbnail" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const path = ctx.item.thumbnailPath ?? "thumbnail.png";
    const f = (severity: Severity, message: string, extra?: Partial<Finding>) =>
      findings.push(finding("thumbnail", "S-06", severity, message, { where: path, ...extra }));
    const bytes = ctx.files.get(path);
    if (!bytes) {
      f("error", `Thumbnail "${path}" not found — add a square transparent PNG (256×256 recommended).`);
      return findings;
    }
    if (!isPng(bytes)) {
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

// ── S-07 name-description ───────────────────────────────────────────────

const nameDescription: CheckDefinition = {
  name: "name-description",
  group: "files",
  rule: "S-07",
  title: "Name & description",
  describe: "name/description length, forbidden characters, tag count",
  appliesTo: (ctx) => (ctx.metadataMode === "none" ? "no metadata to carry a name or description" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const { nameMax, descriptionMax, forbiddenChars, tagsMax } = ctx.manifest.text;
    const fields: { label: string; value: string | undefined; max: number }[] = [
      { label: "name", value: ctx.item.name, max: nameMax },
      { label: "description", value: ctx.item.description, max: descriptionMax }
    ];
    for (const { label, value, max } of fields) {
      if (value === undefined) continue;
      if (value.length > max) {
        findings.push(
          finding("name-description", "S-07", "error", `The ${label} is ${value.length} characters; the maximum is ${max}. Shorten it.`, {
            where: label,
            measured: value.length,
            limit: max
          })
        );
      }
      for (const ch of forbiddenChars) {
        if (value.includes(ch)) {
          findings.push(
            finding("name-description", "S-07", "error", `The ${label} contains "${ch}", which is not allowed — remove it.`, { where: label, data: { character: ch } })
          );
        }
      }
    }
    const tags = (ctx.item.tags ?? []).filter((t) => t.trim() !== "");
    if (tags.length > tagsMax) {
      findings.push(
        finding("name-description", "S-07", "error", `The item has ${tags.length} tags; the maximum is ${tagsMax}. Remove some tags.`, {
          where: "tags",
          measured: tags.length,
          limit: tagsMax
        })
      );
    }
    return findings;
  }
};

// ── S-08 category ───────────────────────────────────────────────────────

const category: CheckDefinition = {
  name: "category",
  group: "files",
  rule: "S-08",
  title: "Category",
  describe: "known category; body_shape is not submittable",
  appliesTo: (ctx) => (ctx.metadataMode === "none" && !ctx.category ? "no metadata or category hint" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    if (ctx.itemType === "emote") {
      const emoteCategory = ctx.item.emoteData?.category ?? ctx.item.category ?? ctx.category;
      if (!EmoteCategory.validate(emoteCategory)) {
        findings.push(finding("category", "S-08", "error", `Unknown or missing emote category "${emoteCategory ?? ""}" — choose a supported category such as dance, fun, or greetings.`, { where: "category", measured: String(emoteCategory ?? "") }));
      }
      return findings;
    }
    const value = ctx.category;
    if (!value) return findings; // missing category is S-03's finding
    if (value === "body_shape") {
      findings.push(
        finding("category", "S-08", "error", 'The category "body_shape" cannot be submitted as a collection item — pick the slot the item actually occupies.', {
          measured: value
        })
      );
    } else if (!WEARABLE_CATEGORY_VALUES.has(value)) {
      findings.push(
        finding("category", "S-08", "error", `Unknown category "${value}" — valid categories are: ${[...WEARABLE_CATEGORY_VALUES].filter((c) => c !== "body_shape").join(", ")}.`, {
          measured: value
        })
      );
    }
    return findings;
  }
};

// ── S-09 content-integrity ──────────────────────────────────────────────

const contentIntegrity: CheckDefinition = {
  name: "content-integrity",
  group: "files",
  rule: "S-09",
  title: "Content integrity",
  describe: "file contents match their declared legacy or CIDv1 hashes",
  appliesTo: (ctx) => (ctx.content ? true : "no entity content list"),
  run: async (ctx) => {
    const findings: Finding[] = [];
    const declared = new Map<string, string>();
    for (const entry of ctx.content ?? []) declared.set(entry.file, entry.hash);

    for (const [file, hash] of declared) {
      const bytes = ctx.files.get(file);
      if (!bytes) {
        findings.push(
          finding("content-integrity", "S-09", "error", `"${file}" is declared in the content list but the file is missing from the upload.`, { where: file })
        );
        continue;
      }
      const computed = await contentHash(bytes, hash.startsWith("Qm") ? 0 : 1);
      if (computed !== hash) {
        findings.push(
          finding(
            "content-integrity",
            "S-09",
            "error",
            `"${file}" does not match its declared hash — the file changed after the content list was built. Rebuild the deployment.`,
            { where: file, measured: computed, limit: hash }
          )
        );
      }
    }
    for (const file of ctx.files.keys()) {
      if (!declared.has(file)) {
        findings.push(
          finding("content-integrity", "S-09", "error", `"${file}" is in the upload but not declared in the content list — declare it or remove it.`, { where: file })
        );
      }
    }
    return findings;
  }
};

// ── S-10 gltf-hygiene ───────────────────────────────────────────────────

const LIGHTS_EXTENSION = "KHR_lights_punctual";

/** True when the node's rotation maps the local Y axis to ±world Z within `tolDeg` — a Z-up export. */
function isZUpRotation(quaternion: [number, number, number, number], tolDeg: number): boolean {
  const [x, y, z, w] = quaternion;
  const rotatedYz = 2 * w * x + 2 * y * z; // Z component of the quaternion-rotated Y axis
  return Math.abs(rotatedYz) >= Math.cos((tolDeg * Math.PI) / 180);
}

const gltfHygiene: CheckDefinition = {
  name: "gltf-hygiene",
  group: "files",
  rule: "S-10",
  title: "glTF hygiene",
  describe: "no cameras or lights; extensions allowlisted; Y-up orientation",
  appliesTo: (ctx) => (isFacial(ctx) ? "facial-feature wearables carry no GLB model" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const allowlist = new Set(ctx.manifest.gltf.extensionAllowlist);
    // Read raw GLB JSON chunks independently of gltf-transform: a GLB with an
    // unsupported required extension refuses to parse — exactly when this check matters.
    const inspected: { where: string; json: Record<string, unknown>; rotationSource?: (typeof ctx.models)[number] }[] = [];
    const parsedByFile = new Map(ctx.models.map((m) => [m.mainFile, m]));
    for (const [path, bytes] of ctx.files) {
      if (!path.endsWith(".glb") || !isGlb(bytes)) continue;
      try {
        inspected.push({ where: path, json: readGlbJsonChunk(bytes), rotationSource: parsedByFile.get(path) });
      } catch {
        // gltf-valid (S-02) reports unreadable containers
      }
    }
    for (const model of inspected) {
      const where = model.where;
      const json = model.json;
      const cameras = json.cameras;
      if (Array.isArray(cameras) && cameras.length > 0) {
        findings.push(
          finding("gltf-hygiene", "S-10", "error", `"${where}" contains ${cameras.length} camera(s) — remove cameras before exporting; they are not allowed in item GLBs.`, {
            where,
            measured: cameras.length
          })
        );
      }
      const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as string[]) : [];
      const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as string[]) : [];
      if (used.includes(LIGHTS_EXTENSION) || required.includes(LIGHTS_EXTENSION)) {
        findings.push(
          finding("gltf-hygiene", "S-10", "error", `"${where}" contains lights (${LIGHTS_EXTENSION}) — remove lights before exporting; they are not allowed in item GLBs.`, {
            where
          })
        );
      }
      for (const ext of required) {
        if (ext === LIGHTS_EXTENSION || allowlist.has(ext)) continue;
        findings.push(
          finding("gltf-hygiene", "S-10", "error", `"${where}" requires the extension "${ext}", which renderers are not guaranteed to support — export without it. Allowed: ${[...allowlist].join(", ")}.`, {
            where,
            data: { extension: ext }
          })
        );
      }
      for (const ext of used) {
        if (ext === LIGHTS_EXTENSION || allowlist.has(ext) || required.includes(ext)) continue;
        findings.push(
          finding("gltf-hygiene", "S-10", "warning", `"${where}" uses the extension "${ext}", which is outside the supported set — it may be ignored by renderers.`, {
            where,
            data: { extension: ext }
          })
        );
      }

      // Off by default: fired on virtually every committee-approved catalyst item (see manifest discrepancies).
      const zUpEnabled = (ctx.manifest.gltf as { zUpHeuristic?: boolean }).zUpHeuristic === true;
      const tolDeg = ctx.manifest.epsilons.zUpRotationToleranceDegrees;
      const parsed = model.rotationSource;
      const scene = parsed ? parsed.doc.getRoot().getDefaultScene() ?? parsed.doc.getRoot().listScenes()[0] : undefined;
      for (const node of zUpEnabled && scene ? scene.listChildren() : []) {
        if (isZUpRotation(node.getRotation(), tolDeg)) {
          findings.push(
            finding(
              "gltf-hygiene",
              "S-10",
              "warning",
              `"${where}"'s root node "${node.getName()}" is rotated ±90° about X — this looks like a Z-up export. Export with Y-up (the Blender toolkit does this automatically).`,
              { where, data: { node: node.getName() } }
            )
          );
          break; // one Z-up warning per model is enough
        }
      }
    }
    return findings;
  }
};

// ── S-11 smart-wearable ─────────────────────────────────────────────────

function isSmartWearable(ctx: CheckContext): boolean {
  if (ctx.files.has("scene.json")) return true;
  if ((ctx.item.requiredPermissions ?? []).length > 0) return true;
  for (const path of ctx.files.keys()) {
    if (/(^|\/)game\.js$/.test(path)) return true;
  }
  return false;
}

const smartWearable: CheckDefinition = {
  name: "smart-wearable",
  group: "files",
  rule: "S-11",
  title: "Smart wearable",
  describe: "scene bundle complete, permissions allowlisted, video within limits, no stray empty files",
  appliesTo: (ctx) =>
    isSmartWearable(ctx) || ctx.emptyFiles.length > 0 ? true : "not a smart wearable (no scene.json, game.js bundle, or requiredPermissions) and no empty files",
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const path of ctx.emptyFiles) {
      findings.push(
        finding("smart-wearable", "S-11", "error", `"${path}" is a 0-byte file — empty files break deployment (it was ignored during validation). Remove it from the zip.`, {
          where: path
        })
      );
    }
    if (!isSmartWearable(ctx)) return findings;

    let scene: Record<string, unknown> | undefined;
    const sceneBytes = ctx.files.get("scene.json");
    if (!sceneBytes) {
      findings.push(finding("smart-wearable", "S-11", "error", "The item looks like a smart wearable but has no scene.json — include the scene definition."));
    } else {
      try {
        scene = JSON.parse(new TextDecoder().decode(sceneBytes)) as Record<string, unknown>;
      } catch {
        findings.push(finding("smart-wearable", "S-11", "error", '"scene.json" is not valid JSON — re-export the smart wearable.', { where: "scene.json" }));
      }
    }
    if (scene) {
      const main = scene.main;
      if (typeof main !== "string" || main === "") {
        findings.push(finding("smart-wearable", "S-11", "error", '"scene.json" declares no main script — set "main" to the compiled JS bundle.', { where: "scene.json" }));
      } else if (!ctx.files.has(main)) {
        findings.push(
          finding("smart-wearable", "S-11", "error", `"scene.json" points at "${main}" but that file is not in the zip — include the compiled bundle.`, { where: main })
        );
      }
    }

    const scenePermissions = Array.isArray(scene?.requiredPermissions) ? (scene.requiredPermissions as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const permissions = new Set([...(ctx.item.requiredPermissions ?? []), ...scenePermissions]);
    for (const permission of permissions) {
      if (!PERMISSION_VALUES.has(permission)) {
        findings.push(
          finding(
            "smart-wearable",
            "S-11",
            "warning",
            `Required permission "${permission}" is not in the allowed set (${[...PERMISSION_VALUES].join(", ")}) — it will be flagged for committee review.`,
            { where: "requiredPermissions", data: { permission } }
          )
        );
      }
    }

    const videoLimit = ctx.manifest.fileSize.smartWearableVideoBytes;
    for (const [path, bytes] of ctx.files) {
      if (path.endsWith(".mp4") && bytes.length > videoLimit) {
        findings.push(
          finding("smart-wearable", "S-11", "error", `Video "${path}" is ${mb(bytes.length)} MB; the maximum is ${mb(videoLimit)} MB.`, {
            where: path,
            measured: bytes.length,
            limit: videoLimit
          })
        );
      }
    }
    return findings;
  }
};

export const filesChecks: CheckDefinition[] = [
  fileFormat,
  gltfValid,
  metadata,
  representations,
  fileSize,
  thumbnail,
  nameDescription,
  category,
  contentIntegrity,
  gltfHygiene,
  smartWearable
];
