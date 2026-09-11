/** M-13 Static mesh — the engine ignores animations and shape keys on wearables, so they only add file size. */
import { listSome } from "../../../logic/format.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "static-mesh", group: "model", rule: "M-13", docs: `${WEARABLES}#building-3d-models-for-wearables` };

export const staticMesh: CheckDefinition = {
  ...meta,
  title: "Static mesh",
  describe: "Wearable GLBs contain no animation clips and no morph targets/shape keys.",
  explanation: "Wearable models shouldn't contain animations or shape keys — the engine ignores them on wearables, so they only add file size.",
  fix: "Delete leftover animations and shape keys before exporting a wearable (in Blender: remove actions in the Dope Sheet and shape keys in Object Data) — they're ignored in-world and only add file size.",
  details: "Wearable GLBs must carry no animation clips and no morph targets — both are errors.",
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
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
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      const clips = model.doc.getRoot().listAnimations().map((a) => a.getName() || "(unnamed)");
      if (clips.length > 0) {
        findings.push(
          finding(meta, "warning",
            `"${model.mainFile}" contains ${clips.length} animation clip${clips.length > 1 ? "s" : ""} (${listSome(clips)}) — the engine ignores animations on wearables, so this is dead weight. Remove them before export to shrink the file.`,
            { where: model.mainFile, measured: clips.length, limit: 0, data: { clips } })
        );
      }
      const morphMeshes: string[] = [];
      for (const mesh of model.doc.getRoot().listMeshes()) {
        if (mesh.listPrimitives().some((prim) => prim.listTargets().length > 0)) morphMeshes.push(mesh.getName() || "(unnamed)");
      }
      if (morphMeshes.length > 0) {
        findings.push(
          finding(meta, "warning",
            `"${model.mainFile}" contains morph targets (shape keys) on: ${listSome(morphMeshes)} — the engine ignores them on wearables, so they only add file size. Apply or delete shape keys before export.`,
            { where: model.mainFile, measured: morphMeshes.length, limit: 0, data: { meshes: morphMeshes } })
        );
      }
    }
    return findings;
  }
};
