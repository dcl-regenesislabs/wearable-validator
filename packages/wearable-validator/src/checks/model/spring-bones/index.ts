/** M-14 Spring bones — physics chains cost per bone, and out-of-range ADR-316 values explode or freeze in-world. */
import { listSome } from "../../../logic/format.js";
import { listJointNames } from "../../../logic/gltf.js";
import { isSpringBoneName } from "../../../logic/skeleton.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "spring-bones", group: "model", rule: "M-14", docs: `${UPLOADING}#spring-bones` };

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

export const springBones: CheckDefinition = {
  ...meta,
  title: "Spring bones",
  describe: "Spring-bone count stays within the limit; springBones metadata parameters are within ADR-316 ranges.",
  explanation: "Spring bones (bouncing hair, tails, earrings) are limited to 12 per item, with their physics values inside the allowed ranges.",
  fix: "Keep at most 12 spring bones (names containing 'springbone') and keep stiffness/gravity/drag inside the allowed ranges.",
  details: "Counts springbone-named joints (warns above 12) and, when spring-bone metadata is present, checks numeric physics parameters against their allowed ranges. Reads settings from published items and from flat or data.springBones fields in Builder manifests.",
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
    const token = ctx.manifest.skeleton.springBoneToken;
    const joints = new Set(ctx.models.flatMap((m) => listJointNames(m.doc)));
    const springs = [...joints].filter((j) => j.toLowerCase().includes(token)).length;
    return `${springs} spring bone${springs === 1 ? "" : "s"}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxSpringBones = ctx.manifest.skeleton.maxSpringBones;

    for (const model of ctx.models) {
      const springJoints = listJointNames(model.doc).filter((name) => isSpringBoneName(ctx, name));
      if (springJoints.length > maxSpringBones) {
        findings.push(
          finding(meta, "warning",
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
              finding(meta, "error",
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
                finding(meta, "error",
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
