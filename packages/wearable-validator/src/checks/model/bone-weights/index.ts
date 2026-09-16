/** M-10 Bone weights — unnormalized or over-influenced vertices deform badly during animation. */
import type { Document } from "@gltf-transform/core";
import { readVec4, round4 } from "../../../logic/weights.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "bone-weights", group: "model", rule: "M-10", docs: `${WEARABLES}#skin-weighting` };

/** Total weight at or below this counts as an unrigged vertex — an algorithmic zero threshold, not a rule limit. */
const ZERO_WEIGHT_EPSILON = 1e-6;

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

export const boneWeights: CheckDefinition = {
  ...meta,
  title: "Bone weights",
  describe: "Skin weights are normalized, use at most 4 influences per vertex, and leave no vertex unrigged.",
  explanation: "Each vertex may be influenced by at most 4 bones, and its weights must add up to 1. Anything else deforms badly during animation.",
  fix: "In Blender Weight Paint: Weights → Limit Total (4), then Weights → Normalize All. Re-check any vertex the finding names.",
  details: "Reads the skinning data directly: per-vertex weights must sum to 1 (±0.02) with at most 4 effective influences — a second joint set with non-zero weights counts. Zero-weight vertices warn.",
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
    const skinned = ctx.models.some((m) => m.doc.getRoot().listSkins().length > 0);
    return skinned ? "skinned" : "not skinned";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxInfluences = ctx.manifest.skeleton.maxInfluences;
    const epsilon = ctx.manifest.skeleton.weightSumEpsilon;
    for (const model of ctx.models) {
      const stats = collectWeightStats(model.doc, maxInfluences, epsilon);
      if (stats.nonNormalized > 0) {
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}": ${stats.nonNormalized} vertices have skin weights that don't sum to 1 (largest deviation ${round4(stats.maxDeviation)}, allowed ±${epsilon}). Normalize weights before export (in Blender: Weights → Normalize All).`,
            { where: model.mainFile, measured: round4(stats.maxDeviation), limit: epsilon, data: { vertices: stats.nonNormalized } })
        );
      }
      if (stats.overInfluenced > 0) {
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}": ${stats.overInfluenced} vertices are skinned to more than ${maxInfluences} bones — Decentraland supports at most ${maxInfluences} influences per vertex. Limit influences (in Blender: Weights → Limit Total) and renormalize.`,
            { where: model.mainFile, measured: stats.maxInfluences, limit: maxInfluences, data: { vertices: stats.overInfluenced } })
        );
      }
      if (stats.zeroWeight > 0) {
        findings.push(
          finding(meta, "warning",
            `"${model.mainFile}": ${stats.zeroWeight} vertices have zero skin weight — they will stay frozen in place while the avatar moves. Weight every vertex to a bone.`,
            { where: model.mainFile, measured: stats.zeroWeight, data: { vertices: stats.zeroWeight } })
        );
      }
    }
    return findings;
  }
};
