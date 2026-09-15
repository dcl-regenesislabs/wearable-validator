/** M-11 Hands geometry — hands_wear items are worn, not held; a prop skinned to the body reads as a sword. */
import type { Document } from "@gltf-transform/core";
import { hasSkinnedMesh } from "../../../logic/gltf.js";
import { readVec4, round4 } from "../../../logic/weights.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "hands-geometry", group: "model", rule: "M-11", docs: `${WEARABLES}#hands` };

const HAND_BONE_PATTERN = /^Avatar_(Left|Right)Hand/;

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

export const handsGeometry: CheckDefinition = {
  ...meta,
  title: "Hands geometry",
  describe: "hands_wear items are skinned to the hand bones — not exported as a held prop.",
  explanation: "Hand accessories must be skinned to the hand bones — worn items like gloves, not held items like swords.",
  fix: "Skin the accessory to the hand bones (Avatar_RightHand / fingers) so it moves with the hand — held props like swords aren't wearables.",
  details: "hands_wear items must contain a skinned mesh with at least half its weight on the hand bones — otherwise it looks like a held prop and warns (the final judgment is visual).",
  appliesTo: (ctx) => {
    const base = wearableGeometryOnly(ctx);
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
        finding(meta, "warning",
          `"${model.mainFile}" looks like a held prop, not a hands wearable — ${detail}. Skin the item to Avatar_LeftHand / Avatar_RightHand and their finger bones.`,
          { where: model.mainFile, measured: round4(ratio ?? 0), limit: minRatio })
      );
    }
    return findings;
  }
};
