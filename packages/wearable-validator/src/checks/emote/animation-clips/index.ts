/** E-02 Animation clips — one avatar clip plus an optional prop clip of equal length, so the runtime knows exactly what to play. */
import { clipDuration, emoteOnly, round3 } from "../../../logic/animation.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "animation-clips", group: "emote", rule: "E-02", docs: `${EMOTES}#number-of-animations` };

export const animationClips: CheckDefinition = {
  ...meta,
  title: "Animation clips",
  describe: "one avatar clip plus an optional prop clip; _Avatar/_Prop suffixes and equal lengths when both exist",
  explanation: "An emote has one avatar animation — plus one prop animation of the same length if it uses a prop — named with the _Avatar/_Prop convention.",
  fix: "Keep exactly one avatar action (plus one prop action of the same length if the emote has a prop) and name them Name_Avatar / Name_Prop.",
  details: "Counts the clips: more than the allowed set fails; a two-clip emote must be the _Avatar/_Prop pair with matching lengths (within one frame).",
  appliesTo: emoteOnly,
  measure: (ctx) => {
    const names = ctx.models.flatMap((m) => m.doc.getRoot().listAnimations().map((a) => a.getName() || "(unnamed)"));
    return names.length > 0 ? `${names.length}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}` : "no clips";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const { maxClipsWithProps, propClipLengthToleranceSeconds } = ctx.manifest.emote;
    for (const model of ctx.models) {
      const anims = model.doc.getRoot().listAnimations();
      const names = anims.map((a) => a.getName());
      if (anims.length === 0) {
        findings.push(
          finding(meta, "error", "No animation clips found — an emote GLB must contain the animation (one clip, or an _Avatar + _Prop pair).", {
            where: model.mainFile,
            measured: 0
          })
        );
        continue;
      }
      if (anims.length > maxClipsWithProps) {
        findings.push(
          finding(
            meta,
            "error",
            `${anims.length} animation clips found — an emote may have at most ${maxClipsWithProps} (one "_Avatar" clip plus an optional "_Prop" clip). Merge or remove the extras.`,
            { where: model.mainFile, measured: anims.length, limit: maxClipsWithProps, data: { clips: names } }
          )
        );
      }
      if (anims.length >= 2) {
        const avatar = anims.find((a) => a.getName().endsWith("_Avatar"));
        const prop = anims.find((a) => a.getName().endsWith("_Prop"));
        if (!avatar || !prop) {
          findings.push(
            finding(
              meta,
              "error",
              `With ${anims.length} clips, one must end in "_Avatar" and one in "_Prop" — found: ${names.join(", ")}. Rename the clips.`,
              { where: model.mainFile, data: { clips: names } }
            )
          );
        } else {
          const avatarSeconds = clipDuration(avatar);
          const propSeconds = clipDuration(prop);
          if (Math.abs(avatarSeconds - propSeconds) > propClipLengthToleranceSeconds) {
            findings.push(
              finding(
                meta,
                "error",
                `The prop clip "${prop.getName()}" runs ${round3(propSeconds)} s but the avatar clip "${avatar.getName()}" runs ${round3(avatarSeconds)} s — both clips must have the same length (within ${propClipLengthToleranceSeconds} s). Re-export them with matching frame ranges.`,
                { where: model.mainFile, measured: round3(propSeconds), limit: round3(avatarSeconds), data: { clips: [prop.getName(), avatar.getName()] } }
              )
            );
          }
        }
      }
    }
    return findings;
  }
};
