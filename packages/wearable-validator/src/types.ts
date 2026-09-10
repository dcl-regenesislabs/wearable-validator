import type { Document } from "@gltf-transform/core";
import { DOCS_LINKS } from "./docs-links.js";
import type { Manifest } from "./manifest/index.js";

export type Group = "files" | "model" | "emote" | "rendering" | "content";
export type Severity = "error" | "warning";
export type CheckStatus = "passed" | "failed" | "warning" | "skipped" | "errored";
export type ItemType = "wearable" | "emote";

export interface Finding {
  check: string;
  group: Group;
  severity: Severity;
  /** Creator-facing: what's wrong + how to fix. */
  message: string;
  /** Mesh / file / bone / representation the finding points at. */
  where?: string;
  measured?: number | string;
  limit?: number | string;
  data?: Record<string, string | number | boolean | string[]>;
  /** Rule-book ID, e.g. 'M-01'. */
  rule: string;
  docs: string;
}

export interface CheckResult {
  check: string;
  group: Group;
  status: CheckStatus;
  /** What the item actually measures for this check (e.g. "1,240 tris"). */
  measured?: string;
  skipReason?: string;
  durationMs?: number;
}

export interface Result {
  /** Computed over core groups only. null = partial run or bare GLB — never infer pass from it. */
  passed: boolean | null;
  checks: CheckResult[];
  findings: Finding[];
  summary: { errors: number; warnings: number; checked: number; skipped: number };
}

export interface Options {
  groups?: Group[];
  /** Wins over groups. Rule IDs ('M-01') accepted as aliases. */
  checks?: string[];
  /** Hint for bare GLBs — unlocks category-dependent limits. */
  category?: string;
  /** Overrides clip-presence inference on bare GLBs. */
  itemType?: ItemType;
  /** Default 260 MB. Exceeding it yields an error finding, never a crash. */
  maxInputBytes?: number;
}

export type Input =
  | Uint8Array
  | {
      files: Map<string, Uint8Array>;
      metadata?: unknown;
      content?: { file: string; hash: string }[];
    };

/** Normalized view of item metadata — from @dcl/schemas entity metadata OR a builder zip manifest. */
export interface NormalizedItem {
  name?: string;
  description?: string;
  category?: string;
  rarity?: string;
  tags?: string[];
  hides?: string[];
  replaces?: string[];
  representations?: { bodyShapes: string[]; mainFile: string; contents: string[]; overrideHides?: string[]; overrideReplaces?: string[] }[];
  thumbnailPath?: string;
  rarityImagePath?: string;
  loop?: boolean;
  springBones?: unknown;
  emoteData?: { category?: string; loop?: boolean; outcomes?: unknown[]; startAnimation?: unknown };
  requiredPermissions?: string[];
}

export interface ParsedModel {
  /** Representation main file path, or the single input file for bare GLBs. */
  mainFile: string;
  bodyShapes: string[];
  bytes: Uint8Array;
  doc: Document;
  /** Raw glTF JSON chunk (for things gltf-transform abstracts away, e.g. cameras/extensions). */
  json: Record<string, unknown>;
}

export type MetadataMode = "entity" | "builder" | "none";
export type InputKind = "zip" | "glb" | "object" | "png-set";

export interface CheckContext {
  files: Map<string, Uint8Array>;
  content?: { file: string; hash: string }[];
  item: NormalizedItem;
  itemType: ItemType;
  /** Resolved category (metadata or hint) — undefined for a hint-less bare GLB. */
  category?: string;
  metadataMode: MetadataMode;
  entityMetadata?: unknown;
  inputKind: InputKind;
  totalBytes: number;
  /** One entry per representation; bare GLB = one entry. Empty when the GLB failed to parse. */
  models: ParsedModel[];
  /** Set when GLB parsing failed — model/emote checks skip with this reason. */
  parseError?: string;
  manifest: Manifest;
  /** 0-byte zip entries stripped at load — smart-wearable's stray-file rule reports them. */
  emptyFiles: string[];
  /** The zip's own wearable.json/emote.json view — the `metadata` check reports divergence from explicit metadata. */
  embeddedManifest?: NormalizedItem;
}

export interface CheckDefinition {
  name: string;
  group: Group;
  rule: string;
  title: string;
  /** One-line "what it verifies" — docs pages generate from this. */
  describe: string;
  /** Emits one warning finding when the category is unknown (bare GLB without hint). */
  categoryDependent?: boolean;
  /** Return a reason string to mark the check not-applicable (absent from results). */
  appliesTo?: (ctx: CheckContext) => true | string;
  run: (ctx: CheckContext) => Finding[] | Promise<Finding[]>;
}

export const DOCS_BASE = "https://dcl-regenesislabs.github.io/wearable-validator/checks";
/** Live creator-docs page per check until the generated per-check site deploys. */
export const docsUrl = (check: string): string => DOCS_LINKS[check] ?? `${DOCS_BASE}/${check}`;
