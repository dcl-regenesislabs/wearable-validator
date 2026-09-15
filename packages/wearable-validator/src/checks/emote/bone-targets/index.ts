/** E-03 Bone targets — tracks that target anything but the avatar's (or prop's) bones never play in-world. */
import type { Node } from "@gltf-transform/core";
import { emoteOnly, parentNode } from "../../../logic/animation.js";
import { AVATAR_BONE_NAME_SET } from "../../../manifest/index.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "bone-targets", group: "emote", rule: "E-03", docs: `${EMOTES}#the-animation-specifications` };

function isUnderNodeNamed(node: Node, name: string): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.getName() === name) return true;
    current = parentNode(current);
  }
  return false;
}

export const boneTargets: CheckDefinition = {
  ...meta,
  title: "Bone targets",
  describe: "animation channels target only canonical avatar bones, spring bones, or prop bones from prop clips",
  explanation: "Animation tracks may only target the avatar's bones (or the prop's). Tracks pointing anywhere else won't play in-world.",
  fix: "Remove animation tracks that target meshes or non-avatar objects — only the avatar's rig bones (and the prop armature) can be animated.",
  details: "Every animation channel must target a canonical avatar bone, a spring bone, or the prop armature — mesh nodes and unknown names fail.",
  appliesTo: emoteOnly,
  measure: (ctx) => {
    let channels = 0;
    for (const model of ctx.models) for (const a of model.doc.getRoot().listAnimations()) channels += a.listChannels().length;
    return `${channels} channels`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const springToken = ctx.manifest.skeleton.springBoneToken.toLowerCase();
    const propArmatureName = ctx.manifest.skeleton.propArmatureName;
    for (const model of ctx.models) {
      const seen = new Set<string>();
      for (const anim of model.doc.getRoot().listAnimations()) {
        const clipName = anim.getName();
        const isPropClip = clipName.endsWith("_Prop");
        for (const channel of anim.listChannels()) {
          const target = channel.getTargetNode();
          if (!target) continue;
          const name = target.getName();
          if (AVATAR_BONE_NAME_SET.has(name)) continue;
          if (name.toLowerCase().includes(springToken)) continue;
          const underProp = isUnderNodeNamed(target, propArmatureName);
          if (underProp && isPropClip) continue;
          const key = `${clipName}::${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const where = `${model.mainFile} › ${name}`;
          if (target.getMesh()) {
            findings.push(
              finding(meta, "error", `Clip "${clipName}" animates the mesh node "${name}" — emotes may only animate avatar bones, never meshes or objects. Remove the object animation and animate the skeleton instead.`, {
                where,
                data: { clip: clipName, node: name }
              })
            );
          } else if (underProp) {
            findings.push(
              finding(meta, "error", `Clip "${clipName}" animates the prop bone "${name}" — bones under "${propArmatureName}" may only be animated from a clip ending in "_Prop". Move those keys to the prop clip.`, {
                where,
                data: { clip: clipName, node: name }
              })
            );
          } else {
            findings.push(
              finding(meta, "error", `Clip "${clipName}" animates "${name}", which is not a canonical Avatar_* bone. Retarget the animation to the Decentraland skeleton (check the bone name's exact casing).`, {
                where,
                data: { clip: clipName, node: name }
              })
            );
          }
        }
      }
    }
    return findings;
  }
};
