/** E-04 Loop seam — a looping emote whose first and last poses differ snaps visibly on every repeat. */
import { channelKeys, emoteOnly, keyValue } from "../../../logic/animation.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "loop-seam", group: "emote", rule: "E-04", docs: `${EMOTES}#the-animation-specifications` };

export const loopSeam: CheckDefinition = {
  ...meta,
  title: "Loop seam",
  describe: "looping emotes end in the pose they start in — no visible snap at the loop point",
  explanation: "Looping emotes must start and end on the same pose, or the loop visibly snaps on every repeat.",
  fix: "Copy the first frame's pose and paste it on the last frame so the loop closes cleanly (Blender: select all bones, Copy Pose on frame 1, Paste on the last frame).",
  details: "For looping emotes, compares the first and last keyframe of every channel (position, rotation and scale epsilons) and lists the bones that would visibly snap.",
  appliesTo: (ctx) => {
    const base = emoteOnly(ctx);
    if (base !== true) return base;
    return ctx.item.loop === true ? true : "loop-seam only applies to looping emotes (loop is not true)";
  },
  measure: (ctx) => (ctx.item.loop === undefined ? undefined : ctx.item.loop ? "loops" : "plays once"),
  run: (ctx) => {
    const findings: Finding[] = [];
    const { loopSeamTranslation, loopSeamQuaternionDot, loopSeamScale } = ctx.manifest.epsilons;
    for (const model of ctx.models) {
      const offenders = new Set<string>();
      for (const anim of model.doc.getRoot().listAnimations()) {
        for (const channel of anim.listChannels()) {
          const path = channel.getTargetPath();
          if (path !== "translation" && path !== "rotation" && path !== "scale") continue;
          const keys = channelKeys(channel);
          if (!keys || keys.count < 2) continue;
          const components = path === "rotation" ? 4 : 3;
          const first = keyValue(keys, 0, components);
          const last = keyValue(keys, keys.count - 1, components);
          let seam = false;
          if (path === "rotation") {
            const dot = Math.abs(first[0] * last[0] + first[1] * last[1] + first[2] * last[2] + first[3] * last[3]);
            seam = dot < loopSeamQuaternionDot;
          } else {
            const dist = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
            seam = dist > (path === "translation" ? loopSeamTranslation : loopSeamScale);
          }
          if (seam) offenders.add(channel.getTargetNode()?.getName() ?? "(unnamed node)");
        }
      }
      if (offenders.size > 0) {
        const bones = [...offenders];
        const shown = bones.slice(0, 5);
        const more = bones.length > 5 ? ` (+${bones.length - 5} more)` : "";
        findings.push(
          finding(meta, "warning", `This looping emote ends in a different pose than it starts — the loop will visibly snap on ${shown.join(", ")}${more}. Match the first and last keyframes of those bones.`, {
            where: model.mainFile,
            data: { bones: shown }
          })
        );
      }
    }
    return findings;
  }
};
