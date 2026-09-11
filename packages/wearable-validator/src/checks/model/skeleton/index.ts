/** M-09 Skeleton — only the canonical Avatar_* rig animates; renamed or leftover bones break the item in-world. */
import { listSome } from "../../../logic/format.js";
import { hasSkinnedMesh, listJointNames } from "../../../logic/gltf.js";
import { isSpringBoneName } from "../../../logic/skeleton.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { AVATAR_BONE_NAME_SET, AVATAR_CORE_BONE_NAMES } from "../../../manifest/index.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "skeleton", group: "model", rule: "M-09", docs: `${WEARABLES}#skin-weighting` };

const AVATAR_BONE_BY_LOWERCASE = new Map([...AVATAR_BONE_NAME_SET].map((name) => [name.toLowerCase(), name]));

export const skeleton: CheckDefinition = {
  ...meta,
  title: "Skeleton",
  describe: "Skinned joints match the canonical Decentraland avatar rig — no unknown, leaf or missing core bones.",
  explanation: "The model must be rigged to the standard avatar skeleton (62 named bones). Renamed, missing or leftover helper bones break the item in-world.",
  fix: "Rig on the official skeleton: import Avatar_File.blend from the Blender toolkit and skin to those bones without renaming them. Delete leftover '_end' helper bones before export.",
  details: "Compares every skin joint against the canonical 62-bone skeleton: unknown non-springbone joints (with a casing hint when it's just casing), leftover _end/_neutral helpers, and missing core bones on skinned meshes all fail.",
  appliesTo: (ctx) => {
    const base = wearableGeometryOnly(ctx);
    if (base !== true) return base;
    if (ctx.models.length > 0 && !ctx.models.some((m) => hasSkinnedMesh(m.doc))) return "no skinned mesh — rigid accessory";
    return true;
  },
  measure: (ctx) => {
    const joints = new Set(ctx.models.flatMap((m) => listJointNames(m.doc)));
    return joints.size > 0 ? `${joints.size} joints` : "not skinned";
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
            finding(meta, "error",
              `"${model.mainFile}": joint "${name}" is a leaf-bone export artifact — delete _end/_neutral bones (in Blender, disable "Add Leaf Bones" on glTF export).`,
              { where: model.mainFile, data: { bone: name } })
          );
          continue;
        }
        if (AVATAR_BONE_NAME_SET.has(name)) continue;
        const canonical = AVATAR_BONE_BY_LOWERCASE.get(lower);
        const hint = canonical ? ` Bone names are case-sensitive — rename it to "${canonical}" (check casing).` : ` Rename it to a canonical Avatar_* bone, or add "${ctx.manifest.skeleton.springBoneToken}" to its name if it is a spring bone.`;
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}": joint "${name}" is not part of the Decentraland avatar skeleton.${hint}`,
            { where: model.mainFile, data: { bone: name, ...(canonical ? { expected: canonical } : {}) } })
        );
      }
      const missing = AVATAR_CORE_BONE_NAMES.filter((name) => !jointSet.has(name));
      if (missing.length > 0) {
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}" is missing core avatar bones: ${listSome(missing)}. Skin the mesh to the canonical Decentraland rig (Avatar_* bones from the creator toolkit).`,
            { where: model.mainFile, measured: missing.length, data: { bones: missing } })
        );
      }
    }
    return findings;
  }
};
