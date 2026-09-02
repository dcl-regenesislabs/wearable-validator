import { Accessor, type Document } from "@gltf-transform/core";
import { computeAabb, countTriangles, hasSkinnedMesh, listJointNames } from "../gltf.js";
import { AVATAR_BONE_NAME_SET, AVATAR_CORE_BONE_NAMES, effectiveTriangleLimit } from "../manifest/index.js";
import type { CheckContext, CheckDefinition, Finding, Severity } from "../types.js";
import { docsUrl } from "../types.js";

const GROUP = "model" as const;

/** Total weight at or below this counts as an unrigged vertex — an algorithmic zero threshold, not a rule limit. */
const ZERO_WEIGHT_EPSILON = 1e-6;

const AVATAR_BONE_BY_LOWERCASE = new Map([...AVATAR_BONE_NAME_SET].map((name) => [name.toLowerCase(), name]));
const HAND_BONE_PATTERN = /^Avatar_(Left|Right)Hand/;
const MAX_LISTED = 5;

function make(check: string, rule: string, severity: Severity, message: string, extra: Partial<Finding> = {}): Finding {
  return { check, group: GROUP, rule, severity, message, docs: docsUrl(check), ...extra };
}

const wearableOnly = (ctx: CheckContext): true | string =>
  ctx.itemType === "wearable" ? true : "wearable-only check — this item is an emote";

function isSpringBoneName(ctx: CheckContext, name: string): boolean {
  return name.toLowerCase().includes(ctx.manifest.skeleton.springBoneToken.toLowerCase());
}

function listSome(names: string[]): string {
  return names.slice(0, MAX_LISTED).join(", ") + (names.length > MAX_LISTED ? ` (+${names.length - MAX_LISTED} more)` : "");
}

// ── accessor reading ─────────────────────────────────────────────────────

function normalizedScale(acc: Accessor): number {
  if (!acc.getNormalized()) return 1;
  switch (acc.getComponentType()) {
    case Accessor.ComponentType.UNSIGNED_BYTE: return 255;
    case Accessor.ComponentType.UNSIGNED_SHORT: return 65535;
    case Accessor.ComponentType.BYTE: return 127;
    case Accessor.ComponentType.SHORT: return 32767;
    default: return 1;
  }
}

/** Reads a VEC4 element, dequantizing normalized integer storage to floats. */
function readVec4(acc: Accessor, index: number): [number, number, number, number] {
  const arr = acc.getArray();
  if (!arr) return [0, 0, 0, 0];
  const scale = normalizedScale(acc);
  const o = index * 4;
  return [(arr[o] ?? 0) / scale, (arr[o + 1] ?? 0) / scale, (arr[o + 2] ?? 0) / scale, (arr[o + 3] ?? 0) / scale];
}

// ── M-01 triangle-count ──────────────────────────────────────────────────

const triangleCount: CheckDefinition = {
  name: "triangle-count",
  group: GROUP,
  rule: "M-01",
  title: "Triangle count",
  describe: "Triangle count stays within the per-category budget, including hidden-slot pooling.",
  categoryDependent: true,
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const category = ctx.category!;
    const hides = [...new Set(ctx.item.hides ?? [])];
    const limit = effectiveTriangleLimit(category, hides);
    for (const model of ctx.models) {
      const { total, hasStripOrFan } = countTriangles(model.doc);
      if (total > limit) {
        const pooled = hides.length > 0 ? ` (base budget for ${category} plus the hidden slots: ${hides.join(", ")})` : ` for ${category}`;
        findings.push(
          make("triangle-count", "M-01", "error",
            `"${model.mainFile}" has ${total} triangles — the limit is ${limit}${pooled}. Remove geometry, or hide more slots to pool their budgets.`,
            { where: model.mainFile, measured: total, limit, data: { category, hides } })
        );
      }
      if (hasStripOrFan) {
        findings.push(
          make("triangle-count", "M-01", "warning",
            `"${model.mainFile}" uses TRIANGLE_STRIP/FAN primitives — these count as vertices−2 triangles per glTF, but most exporters emit plain triangle lists. Re-export with triangles for predictable counting.`,
            { where: model.mainFile })
        );
      }
    }
    return findings;
  }
};

// ── M-08 bounding-box ────────────────────────────────────────────────────

const boundingBox: CheckDefinition = {
  name: "bounding-box",
  group: GROUP,
  rule: "M-08",
  title: "Bounding box",
  describe: "The rest-pose model fits inside the maximum avatar-slot dimensions.",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const box = ctx.manifest.boundingBox;
    for (const model of ctx.models) {
      const aabb = computeAabb(model.doc);
      if (!aabb) continue;
      if (aabb.width > box.width || aabb.height > box.height || aabb.depth > box.depth) {
        findings.push(
          make("bounding-box", "M-08", "error",
            `"${model.mainFile}" measures ${aabb.width} × ${aabb.height} × ${aabb.depth} m (W×H×D) at rest pose — wearables must fit inside ${box.width} × ${box.height} × ${box.depth} m. Scale the model to the avatar's proportions before export.`,
            {
              where: model.mainFile,
              measured: `${aabb.width}×${aabb.height}×${aabb.depth} m`,
              limit: `${box.width}×${box.height}×${box.depth} m`,
              data: { width: aabb.width, height: aabb.height, depth: aabb.depth }
            })
        );
      }
    }
    return findings;
  }
};

// ── M-09 skeleton ────────────────────────────────────────────────────────

const skeleton: CheckDefinition = {
  name: "skeleton",
  group: GROUP,
  rule: "M-09",
  title: "Skeleton",
  describe: "Skinned joints match the canonical Decentraland avatar rig — no unknown, leaf or missing core bones.",
  appliesTo: (ctx) => {
    const base = wearableOnly(ctx);
    if (base !== true) return base;
    if (ctx.models.length > 0 && !ctx.models.some((m) => hasSkinnedMesh(m.doc))) return "no skinned mesh — rigid accessory";
    return true;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const armatureName = ctx.manifest.skeleton.armatureName;
    for (const model of ctx.models) {
      if (!hasSkinnedMesh(model.doc)) continue;
      const joints = listJointNames(model.doc);
      const jointSet = new Set(joints);
      for (const name of joints) {
        if (name === armatureName) continue; // some exporters include the armature root in the joint list
        if (isSpringBoneName(ctx, name)) continue;
        const lower = name.toLowerCase();
        if (lower.endsWith("_end") || lower.endsWith("_neutral")) {
          findings.push(
            make("skeleton", "M-09", "error",
              `"${model.mainFile}": joint "${name}" is a leaf-bone export artifact — delete _end/_neutral bones (in Blender, disable "Add Leaf Bones" on glTF export).`,
              { where: model.mainFile, data: { bone: name } })
          );
          continue;
        }
        if (AVATAR_BONE_NAME_SET.has(name)) continue;
        const canonical = AVATAR_BONE_BY_LOWERCASE.get(lower);
        const hint = canonical ? ` Bone names are case-sensitive — rename it to "${canonical}" (check casing).` : ` Rename it to a canonical Avatar_* bone, or add "${ctx.manifest.skeleton.springBoneToken}" to its name if it is a spring bone.`;
        findings.push(
          make("skeleton", "M-09", "error",
            `"${model.mainFile}": joint "${name}" is not part of the Decentraland avatar skeleton.${hint}`,
            { where: model.mainFile, data: { bone: name, ...(canonical ? { expected: canonical } : {}) } })
        );
      }
      const missing = AVATAR_CORE_BONE_NAMES.filter((name) => !jointSet.has(name));
      if (missing.length > 0) {
        findings.push(
          make("skeleton", "M-09", "error",
            `"${model.mainFile}" is missing core avatar bones: ${listSome(missing)}. Skin the mesh to the canonical Decentraland rig (Avatar_* bones from the creator toolkit).`,
            { where: model.mainFile, measured: missing.length, data: { bones: missing } })
        );
      }
    }
    return findings;
  }
};

// ── M-10 bone-weights ────────────────────────────────────────────────────

interface WeightStats {
  nonNormalized: number;
  maxDeviation: number;
  overInfluenced: number;
  maxInfluences: number;
  zeroWeight: number;
}

function collectWeightStats(doc: Document, maxInfluences: number, epsilon: number): WeightStats {
  const stats: WeightStats = { nonNormalized: 0, maxDeviation: 0, overInfluenced: 0, maxInfluences: 0, zeroWeight: 0 };
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !node.getSkin()) continue;
    for (const prim of mesh.listPrimitives()) {
      const w0 = prim.getAttribute("WEIGHTS_0");
      if (!w0) continue;
      const w1 = prim.getAttribute("WEIGHTS_1");
      const count = w0.getCount();
      for (let v = 0; v < count; v++) {
        const first = readVec4(w0, v);
        const second = w1 ? readVec4(w1, v) : null;
        const all = second ? [...first, ...second] : first;
        const sum = all.reduce((a, b) => a + b, 0);
        if (sum <= ZERO_WEIGHT_EPSILON) {
          stats.zeroWeight++;
          continue;
        }
        const deviation = Math.abs(sum - 1);
        if (deviation > epsilon) {
          stats.nonNormalized++;
          if (deviation > stats.maxDeviation) stats.maxDeviation = deviation;
        }
        const influences = all.filter((w) => w > 0).length;
        if (influences > stats.maxInfluences) stats.maxInfluences = influences;
        // Any live weight in a second set means the vertex was authored with >4 influences.
        if (influences > maxInfluences || (second !== null && second.some((w) => w > 0))) stats.overInfluenced++;
      }
    }
  }
  return stats;
}

const boneWeights: CheckDefinition = {
  name: "bone-weights",
  group: GROUP,
  rule: "M-10",
  title: "Bone weights",
  describe: "Skin weights are normalized, use at most 4 influences per vertex, and leave no vertex unrigged.",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxInfluences = ctx.manifest.skeleton.maxInfluences;
    const epsilon = ctx.manifest.skeleton.weightSumEpsilon;
    for (const model of ctx.models) {
      const stats = collectWeightStats(model.doc, maxInfluences, epsilon);
      if (stats.nonNormalized > 0) {
        findings.push(
          make("bone-weights", "M-10", "error",
            `"${model.mainFile}": ${stats.nonNormalized} vertices have skin weights that don't sum to 1 (largest deviation ${round4(stats.maxDeviation)}, allowed ±${epsilon}). Normalize weights before export (in Blender: Weights → Normalize All).`,
            { where: model.mainFile, measured: round4(stats.maxDeviation), limit: epsilon, data: { vertices: stats.nonNormalized } })
        );
      }
      if (stats.overInfluenced > 0) {
        findings.push(
          make("bone-weights", "M-10", "error",
            `"${model.mainFile}": ${stats.overInfluenced} vertices are skinned to more than ${maxInfluences} bones — Decentraland supports at most ${maxInfluences} influences per vertex. Limit influences (in Blender: Weights → Limit Total) and renormalize.`,
            { where: model.mainFile, measured: stats.maxInfluences, limit: maxInfluences, data: { vertices: stats.overInfluenced } })
        );
      }
      if (stats.zeroWeight > 0) {
        findings.push(
          make("bone-weights", "M-10", "warning",
            `"${model.mainFile}": ${stats.zeroWeight} vertices have zero skin weight — they will stay frozen in place while the avatar moves. Weight every vertex to a bone.`,
            { where: model.mainFile, measured: stats.zeroWeight, data: { vertices: stats.zeroWeight } })
        );
      }
    }
    return findings;
  }
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

// ── M-11 hands-geometry ──────────────────────────────────────────────────

/** Fraction of total skin weight bound to Avatar_(Left|Right)Hand* bones; null when nothing is skinned. */
function handWeightRatio(doc: Document): number | null {
  let total = 0;
  let hand = 0;
  let any = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin) continue;
    const joints = skin.listJoints();
    for (const prim of mesh.listPrimitives()) {
      const j0 = prim.getAttribute("JOINTS_0");
      const w0 = prim.getAttribute("WEIGHTS_0");
      if (!j0 || !w0) continue;
      any = true;
      const jointArr = j0.getArray();
      if (!jointArr) continue;
      const count = w0.getCount();
      for (let v = 0; v < count; v++) {
        const weights = readVec4(w0, v);
        for (let c = 0; c < 4; c++) {
          const w = weights[c];
          if (w <= 0) continue;
          total += w;
          const jointName = joints[jointArr[v * 4 + c]]?.getName() ?? "";
          if (HAND_BONE_PATTERN.test(jointName)) hand += w;
        }
      }
    }
  }
  if (!any || total === 0) return null;
  return hand / total;
}

const handsGeometry: CheckDefinition = {
  name: "hands-geometry",
  group: GROUP,
  rule: "M-11",
  title: "Hands geometry",
  describe: "hands_wear items are skinned to the hand bones — not exported as a held prop.",
  appliesTo: (ctx) => {
    const base = wearableOnly(ctx);
    if (base !== true) return base;
    if (ctx.category !== "hands_wear") return "only applies to hands_wear items";
    return true;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const minRatio = ctx.manifest.hands.minHandWeightRatio;
    for (const model of ctx.models) {
      const ratio = hasSkinnedMesh(model.doc) ? handWeightRatio(model.doc) ?? 0 : null;
      if (ratio !== null && ratio >= minRatio) continue;
      const detail = ratio === null
        ? "it has no skinned mesh"
        : `only ${Math.round(ratio * 100)}% of its skin weight is on hand bones (minimum ${Math.round(minRatio * 100)}%)`;
      findings.push(
        make("hands-geometry", "M-11", "warning",
          `"${model.mainFile}" looks like a held prop, not a hands wearable — ${detail}. Skin the item to Avatar_LeftHand / Avatar_RightHand and their finger bones.`,
          { where: model.mainFile, measured: round4(ratio ?? 0), limit: minRatio })
      );
    }
    return findings;
  }
};

// ── M-12 hides-replaces ──────────────────────────────────────────────────

const hidesReplaces: CheckDefinition = {
  name: "hides-replaces",
  group: GROUP,
  rule: "M-12",
  title: "Hides/replaces",
  describe: "hides/replaces don't include the item's own category; skins hide the full ADR-60 set.",
  categoryDependent: true,
  appliesTo: (ctx) => {
    const base = wearableOnly(ctx);
    if (base !== true) return base;
    if (ctx.metadataMode === "none") return "no metadata — hides/replaces come from the item manifest";
    return true;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const category = ctx.category!;
    const hides = ctx.item.hides ?? [];
    const replaces = ctx.item.replaces ?? [];
    if (hides.includes(category)) {
      findings.push(
        make("hides-replaces", "M-12", "error",
          `hides includes the item's own category "${category}" — a wearable can't hide its own slot (it would hide itself). Remove "${category}" from hides.`,
          { measured: category, data: { category, hides } })
      );
    }
    if (replaces.includes(category)) {
      findings.push(
        make("hides-replaces", "M-12", "error",
          `replaces includes the item's own category "${category}" — a wearable can't replace its own slot. Remove "${category}" from replaces.`,
          { measured: category, data: { category, replaces } })
      );
    }
    if (category === "skin") {
      const missing = ctx.manifest.skinAutoHideSet.filter((slot) => !hides.includes(slot));
      if (missing.length > 0) {
        findings.push(
          make("hides-replaces", "M-12", "warning",
            `Skins should hide the full avatar (ADR-60) — hides is missing: ${missing.join(", ")}. Add them so the skin overrides every base category.`,
            { data: { missing } })
        );
      }
    }
    return findings;
  }
};

// ── M-13 static-mesh ─────────────────────────────────────────────────────

const staticMesh: CheckDefinition = {
  name: "static-mesh",
  group: GROUP,
  rule: "M-13",
  title: "Static mesh",
  describe: "Wearable GLBs contain no animation clips and no morph targets/shape keys.",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      const clips = model.doc.getRoot().listAnimations().map((a) => a.getName() || "(unnamed)");
      if (clips.length > 0) {
        findings.push(
          make("static-mesh", "M-13", "error",
            `"${model.mainFile}" contains ${clips.length} animation clip${clips.length > 1 ? "s" : ""} (${listSome(clips)}) — wearable models must be static. Remove all animations before export.`,
            { where: model.mainFile, measured: clips.length, limit: 0, data: { clips } })
        );
      }
      const morphMeshes: string[] = [];
      for (const mesh of model.doc.getRoot().listMeshes()) {
        if (mesh.listPrimitives().some((prim) => prim.listTargets().length > 0)) morphMeshes.push(mesh.getName() || "(unnamed)");
      }
      if (morphMeshes.length > 0) {
        findings.push(
          make("static-mesh", "M-13", "error",
            `"${model.mainFile}" contains morph targets (shape keys) on: ${listSome(morphMeshes)} — wearable models must be static. Apply or delete shape keys before export.`,
            { where: model.mainFile, measured: morphMeshes.length, limit: 0, data: { meshes: morphMeshes } })
        );
      }
    }
    return findings;
  }
};

// ── M-14 spring-bones ────────────────────────────────────────────────────

const SPRING_PARAM_KEYS = ["stiffness", "gravityPower", "drag", "gravityDir"];

interface SpringConfig {
  name: string;
  config: Record<string, unknown>;
}

/** Tolerant walk over ADR-316 springBones metadata: any object carrying spring params is a bone config. */
function collectSpringConfigs(value: unknown, name: string, out: SpringConfig[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSpringConfigs(item, name, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (SPRING_PARAM_KEYS.some((key) => key in obj)) {
    out.push({ name: typeof obj.name === "string" ? obj.name : name, config: obj });
    return;
  }
  for (const [key, child] of Object.entries(obj)) collectSpringConfigs(child, key, out, depth + 1);
}

const springBones: CheckDefinition = {
  name: "spring-bones",
  group: GROUP,
  rule: "M-14",
  title: "Spring bones",
  describe: "Spring-bone count stays within the limit; springBones metadata parameters are within ADR-316 ranges.",
  appliesTo: wearableOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxSpringBones = ctx.manifest.skeleton.maxSpringBones;

    for (const model of ctx.models) {
      const springJoints = listJointNames(model.doc).filter((name) => isSpringBoneName(ctx, name));
      if (springJoints.length > maxSpringBones) {
        findings.push(
          make("spring-bones", "M-14", "warning",
            `"${model.mainFile}" has ${springJoints.length} spring bones (${listSome(springJoints)}) — the limit is ${maxSpringBones}. Remove or merge spring-bone chains.`,
            { where: model.mainFile, measured: springJoints.length, limit: maxSpringBones, data: { bones: springJoints } })
        );
      }
    }

    if (ctx.item.springBones != null) {
      const ranges = ctx.manifest.skeleton.springBone;
      const configs: SpringConfig[] = [];
      collectSpringConfigs(ctx.item.springBones, "spring bone", configs);
      for (const { name, config } of configs) {
        const scalar = (field: "stiffness" | "gravityPower" | "drag") => {
          const value = config[field];
          if (typeof value !== "number") return;
          const [min, max] = ranges[field];
          if (value < min || value > max) {
            findings.push(
              make("spring-bones", "M-14", "error",
                `Spring bone "${name}": ${field} is ${value} — the allowed range is ${min} to ${max}. Adjust it in the item's spring-bone settings.`,
                { where: name, measured: value, limit: `${min}–${max}`, data: { bone: name, field } })
            );
          }
        };
        scalar("stiffness");
        scalar("gravityPower");
        scalar("drag");
        const dir = config.gravityDir;
        if (Array.isArray(dir)) {
          const [min, max] = ranges.gravityDir;
          for (const component of dir) {
            if (typeof component === "number" && (component < min || component > max)) {
              findings.push(
                make("spring-bones", "M-14", "error",
                  `Spring bone "${name}": gravityDir component ${component} is outside the allowed range ${min} to ${max}. Adjust it in the item's spring-bone settings.`,
                  { where: name, measured: component, limit: `${min}–${max}`, data: { bone: name, field: "gravityDir" } })
              );
              break;
            }
          }
        }
      }
    }

    return findings;
  }
};

export const modelGeometryChecks: CheckDefinition[] = [
  triangleCount,
  boundingBox,
  skeleton,
  boneWeights,
  handsGeometry,
  hidesReplaces,
  staticMesh,
  springBones
];
