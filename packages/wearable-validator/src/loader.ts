import JSZip from "jszip";
import { isGlb, parseGlb } from "./gltf.js";
import { manifest } from "./manifest/index.js";
import type { CheckContext, Finding, Input, InputKind, ItemType, MetadataMode, NormalizedItem, Options, ParsedModel } from "./types.js";
import { docsUrl } from "./types.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const MANIFEST_NAMES = ["wearable.json", "emote.json"];

export interface LoadedInput {
  ctx?: CheckContext;
  /** Fatal input problems (unrecognized bytes, oversized input) — returned as findings, never thrown. */
  fatal?: Finding[];
}

function fileFormatFinding(message: string, data?: Finding["data"]): Finding {
  return { check: "file-format", group: "files", severity: "error", message, data, rule: "S-01", docs: docsUrl("file-format") };
}

export async function loadInput(input: Input, options: Options): Promise<LoadedInput> {
  const maxBytes = options.maxInputBytes ?? manifest.fileSize.maxInputBytes;

  if (input instanceof Uint8Array) {
    if (input.length > maxBytes) {
      return { fatal: [fileFormatFinding(`Input is ${mb(input.length)} MB — the maximum accepted input is ${mb(maxBytes)} MB.`, { measuredBytes: input.length })] };
    }
    if (input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04) {
      return loadZip(input, options);
    }
    if (isGlb(input)) return loadBareGlb(input, options);
    if (PNG_SIGNATURE.every((b, i) => input[i] === b)) {
      if (options.category && manifest.facialCategories.includes(options.category)) {
        return loadPngSet(input, options);
      }
      return { fatal: [fileFormatFinding("PNG input is only valid for facial features — pass a category of eyebrows, eyes or mouth.")] };
    }
    return { fatal: [fileFormatFinding("Unrecognized input: expected a .zip, a .glb, or a facial-feature PNG (with a category hint).")] };
  }

  return loadObjectInput(input, options);
}

async function loadZip(bytes: Uint8Array, options: Options): Promise<LoadedInput> {
  const zip = await JSZip.loadAsync(bytes);
  const files = new Map<string, Uint8Array>();
  const emptyFiles: string[] = [];
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const path = normalizePath(rawPath);
    const base = path.split("/").pop() ?? path;
    if (base.startsWith(".")) continue;
    const data = await entry.async("uint8array");
    if (data.length === 0) {
      emptyFiles.push(path);
      continue;
    }
    if (files.has(path)) throw new Error(`duplicate file path after normalization: "${path}"`);
    files.set(path, data);
  }
  if (files.has("asset.json")) {
    return { fatal: [fileFormatFinding("Legacy asset.json zips are not supported — export the item from the Builder (wearable.json / emote.json) instead.")] };
  }
  return buildContext({ files, emptyFiles, inputKind: "zip", totalBytes: bytes.length, options });
}

async function loadBareGlb(bytes: Uint8Array, options: Options): Promise<LoadedInput> {
  const files = new Map<string, Uint8Array>([["model.glb", bytes]]);
  return buildContext({ files, emptyFiles: [], inputKind: "glb", totalBytes: bytes.length, options });
}

async function loadPngSet(bytes: Uint8Array, options: Options): Promise<LoadedInput> {
  const files = new Map<string, Uint8Array>([["main.png", bytes]]);
  return buildContext({ files, emptyFiles: [], inputKind: "png-set", totalBytes: bytes.length, options });
}

async function loadObjectInput(
  input: { files: Map<string, Uint8Array>; metadata?: unknown; content?: { file: string; hash: string }[] },
  options: Options
): Promise<LoadedInput> {
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const [rawPath, data] of input.files) {
    const path = normalizePath(rawPath);
    if (files.has(path)) throw new Error(`duplicate file path after normalization: "${path}"`);
    files.set(path, data);
    totalBytes += data.length;
  }
  const maxBytes = options.maxInputBytes ?? manifest.fileSize.maxInputBytes;
  if (totalBytes > maxBytes) {
    return { fatal: [fileFormatFinding(`Input is ${mb(totalBytes)} MB — the maximum accepted input is ${mb(maxBytes)} MB.`)] };
  }
  return buildContext({ files, emptyFiles: [], inputKind: "object", totalBytes, options, entityMetadata: input.metadata, content: input.content });
}

interface BuildArgs {
  files: Map<string, Uint8Array>;
  emptyFiles: string[];
  inputKind: InputKind;
  totalBytes: number;
  options: Options;
  entityMetadata?: unknown;
  content?: { file: string; hash: string }[];
}

async function buildContext(args: BuildArgs): Promise<LoadedInput> {
  const { files, inputKind, options } = args;

  let metadataMode: MetadataMode = "none";
  let item: NormalizedItem = {};
  const embedded = readEmbeddedManifest(files);

  if (args.entityMetadata) {
    metadataMode = "entity";
    item = normalizeEntityMetadata(args.entityMetadata);
  } else if (embedded) {
    metadataMode = "builder";
    item = embedded.item;
  }
  // Explicit metadata beats the embedded manifest; divergence is surfaced by the `metadata` check.

  const itemTypeFromMetadata: ItemType | undefined =
    metadataMode !== "none" ? (item.emoteData || embedded?.kind === "emote" ? "emote" : "wearable") : undefined;

  // Parse every model (per representation, deduped by mainFile).
  const models: ParsedModel[] = [];
  let parseError: string | undefined;
  const modelPaths = resolveModelPaths(files, item);
  for (const { mainFile, bodyShapes } of modelPaths) {
    const bytes = files.get(mainFile);
    if (!bytes) continue; // representations (S-04) reports the missing file
    if (!isGlb(bytes)) {
      parseError = `"${mainFile}" is not a GLB (.gltf with external buffers is not supported — export as .glb)`;
      continue;
    }
    try {
      const { doc, json } = await parseGlb(bytes);
      models.push({ mainFile, bodyShapes, bytes, doc, json });
    } catch (err) {
      parseError = `"${mainFile}" failed to parse: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const itemType: ItemType =
    options.itemType ??
    itemTypeFromMetadata ??
    (models.some((m) => m.doc.getRoot().listAnimations().length > 0) ? "emote" : "wearable");

  const category = item.category ?? options.category;

  const ctx: CheckContext = {
    files,
    content: args.content,
    item,
    itemType,
    category,
    metadataMode,
    inputKind,
    totalBytes: args.totalBytes,
    models,
    parseError,
    manifest,
    emptyFiles: args.emptyFiles,
    embeddedManifest: embedded?.item
  };
  return { ctx };
}

function resolveModelPaths(files: Map<string, Uint8Array>, item: NormalizedItem): { mainFile: string; bodyShapes: string[] }[] {
  if (item.representations && item.representations.length > 0) {
    const seen = new Map<string, string[]>();
    for (const rep of item.representations) {
      const existing = seen.get(rep.mainFile);
      if (existing) existing.push(...rep.bodyShapes);
      else seen.set(rep.mainFile, [...rep.bodyShapes]);
    }
    return [...seen.entries()].map(([mainFile, bodyShapes]) => ({ mainFile, bodyShapes }));
  }
  // Manifest-less: first model path becomes the main model, worn by both shapes.
  const modelPath = [...files.keys()].find((p) => p.endsWith(".glb") || p.endsWith(".gltf"));
  return modelPath ? [{ mainFile: modelPath, bodyShapes: ["male", "female"] }] : [];
}

function readEmbeddedManifest(files: Map<string, Uint8Array>): { kind: "wearable" | "emote"; item: NormalizedItem } | undefined {
  for (const name of MANIFEST_NAMES) {
    const bytes = files.get(name);
    if (!bytes) continue;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const kind = name === "emote.json" ? "emote" : "wearable";
      return { kind, item: normalizeBuilderManifest(parsed, kind) };
    } catch {
      return { kind: name === "emote.json" ? "emote" : "wearable", item: {} }; // `metadata` check reports unparseable manifests
    }
  }
  return undefined;
}

/** Builder wearable.json / emote.json — fields live either flat or under `data`. Tolerant by design. */
function normalizeBuilderManifest(raw: Record<string, unknown>, kind: "wearable" | "emote"): NormalizedItem {
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const pick = <T>(key: string): T | undefined => (data[key] ?? raw[key]) as T | undefined;
  const item: NormalizedItem = {
    name: raw.name as string | undefined,
    description: raw.description as string | undefined,
    rarity: raw.rarity as string | undefined,
    category: pick<string>("category"),
    tags: pick<string[]>("tags"),
    hides: pick<string[]>("hides"),
    replaces: pick<string[]>("replaces"),
    representations: pick<NormalizedItem["representations"]>("representations"),
    requiredPermissions: pick<string[]>("requiredPermissions")
  };
  if (kind === "emote") {
    item.emoteData = { category: pick<string>("category"), loop: (pick<boolean>("loop") ?? (raw.play_mode === "loop")) || undefined };
    item.loop = item.emoteData.loop;
  }
  return item;
}

/** @dcl/schemas entity metadata (Wearable | Emote). */
function normalizeEntityMetadata(raw: unknown): NormalizedItem {
  const meta = raw as Record<string, unknown>;
  const emoteData = meta.emoteDataADR74 as Record<string, unknown> | undefined;
  const data = (meta.data ?? emoteData ?? {}) as Record<string, unknown>;
  const reps = (data.representations ?? []) as { bodyShapes: string[]; mainFile: string; contents: string[]; overrideHides?: string[]; overrideReplaces?: string[] }[];
  return {
    name: meta.name as string | undefined,
    description: meta.description as string | undefined,
    rarity: meta.rarity as string | undefined,
    category: (data.category ?? undefined) as string | undefined,
    tags: (data.tags ?? undefined) as string[] | undefined,
    hides: (data.hides ?? undefined) as string[] | undefined,
    replaces: (data.replaces ?? undefined) as string[] | undefined,
    representations: reps.length ? reps : undefined,
    thumbnailPath: meta.thumbnail as string | undefined,
    rarityImagePath: meta.image as string | undefined,
    springBones: (data as { springBones?: unknown }).springBones,
    requiredPermissions: (data.requiredPermissions ?? undefined) as string[] | undefined,
    emoteData: emoteData
      ? { category: emoteData.category as string | undefined, loop: emoteData.loop as boolean | undefined, outcomes: emoteData.outcomes as unknown[] | undefined, startAnimation: emoteData.startAnimation }
      : undefined,
    loop: emoteData?.loop as boolean | undefined
  };
}

export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
