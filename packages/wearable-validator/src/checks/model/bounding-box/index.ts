/** M-08 Bounding box — anything larger than the avatar's slot bounds clips through the world and other players. */
import { computeAabb, formatDimensions } from "../../../logic/gltf.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "bounding-box", group: "model", rule: "M-08", docs: `${WEARABLES}#building-3d-models-for-wearables` };

export const boundingBox: CheckDefinition = {
  ...meta,
  title: "Bounding box",
  describe: "The rest-pose model fits inside the maximum avatar-slot dimensions.",
  explanation: "The model must fit within the avatar's bounds: 2.42 m high, 2.42 m wide, 1.4 m deep.",
  fix: "Scale the model down to fit the avatar bounds (2.42 × 2.42 × 1.4 m) and apply the scale (Ctrl+A in Blender). Check your export units are meters.",
  details: "Computes rest-pose world-space bounds from transformed mesh bounds, excluding colliders. Compares dimensions at glTF float32 precision against 2.42 × 2.42 × 1.4 m before formatting them for display.",
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
    const bounds = ctx.models.flatMap(model => {
      const box = computeAabb(model.doc);
      return box ? [{ file: model.mainFile, value: formatDimensions(box) }] : [];
    });
    if (bounds.length === 1) return bounds[0].value;
    return bounds.length > 0 ? bounds.map(box => `${box.file}: ${box.value}`).join(" / ") : undefined;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const box = ctx.manifest.boundingBox;
    for (const model of ctx.models) {
      const aabb = computeAabb(model.doc);
      if (!aabb) continue;
      // Compare at glTF POSITION's float32 precision, without centimetre rounding.
      if (Math.fround(aabb.width) > Math.fround(box.width) || Math.fround(aabb.height) > Math.fround(box.height) || Math.fround(aabb.depth) > Math.fround(box.depth)) {
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}" measures ${formatDimensions(aabb)} (W×H×D) at rest pose — wearables must fit inside ${box.width} × ${box.height} × ${box.depth} m. Scale the model to the avatar's proportions before export.`,
            {
              where: model.mainFile,
              measured: formatDimensions(aabb),
              limit: `${box.width}×${box.height}×${box.depth} m`,
              data: { width: aabb.width, height: aabb.height, depth: aabb.depth }
            })
        );
      }
    }
    return findings;
  }
};
