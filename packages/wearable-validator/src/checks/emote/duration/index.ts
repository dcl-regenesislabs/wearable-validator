/** E-01 Duration — emotes have a hard 10 s cap so the animation fits the in-world emote slot. */
import { channelKeys, emoteOnly, keyTime, round3 } from "../../../logic/animation.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "duration", group: "emote", rule: "E-01", docs: `${EMOTES}#the-animation-length` };

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function maxClipSeconds(ctx: CheckContext): number {
  let max = 0;
  for (const model of ctx.models) {
    for (const animation of model.doc.getRoot().listAnimations()) {
      for (const sampler of animation.listSamplers()) {
        const end = sampler.getInput()?.getMax([0])[0] ?? 0;
        if (end > max) max = end;
      }
    }
  }
  return max;
}

export const duration: CheckDefinition = {
  ...meta,
  title: "Duration",
  describe: "animation length within the emote limit; ~30 fps keyframe spacing advisory",
  explanation: "Emotes are limited to 10 seconds (300 frames at 30 fps).",
  fix: "Trim the animation to 10 seconds — 300 frames at 30 fps. Set the scene to 30 fps and cut keys past frame 300.",
  details: "Takes the longest keyframe time across every channel of every clip — over 10 s fails. A frame rate inferred far from 30 fps warns.",
  appliesTo: emoteOnly,
  measure: (ctx) => {
    const seconds = maxClipSeconds(ctx);
    return seconds > 0 ? `${Math.round(seconds * 100) / 100} s` : undefined;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const { maxDurationSeconds, expectedFps, fpsTolerance } = ctx.manifest.emote;
    for (const model of ctx.models) {
      const anims = model.doc.getRoot().listAnimations();
      if (anims.length === 0) continue;
      let measured = 0;
      const deltas: number[] = [];
      for (const anim of anims) {
        for (const channel of anim.listChannels()) {
          const keys = channelKeys(channel);
          if (!keys) continue;
          let prev: number | null = null;
          for (let i = 0; i < keys.count; i++) {
            const t = keyTime(keys, i);
            if (t > measured) measured = t;
            if (prev !== null && t > prev) deltas.push(t - prev);
            prev = t;
          }
        }
      }
      if (measured > maxDurationSeconds) {
        findings.push(
          finding(meta, "error", `The animation runs ${round3(measured)} s — emotes must fit in ${maxDurationSeconds} s. Trim or speed up the clip.`, {
            where: model.mainFile,
            measured: round3(measured),
            limit: maxDurationSeconds
          })
        );
      }
      const median = medianOf(deltas);
      if (median !== null && median > 0) {
        const fps = 1 / median;
        if (Math.abs(fps - expectedFps) > fpsTolerance) {
          findings.push(
            finding(
              meta,
              "warning",
              `Keyframe spacing suggests ~${round1(fps)} fps — emotes are expected around ${expectedFps} fps (±${fpsTolerance}). Re-export the animation sampled at ${expectedFps} fps.`,
              { where: model.mainFile, measured: round1(fps), limit: `${expectedFps}±${fpsTolerance} fps`, data: { advisory: true } }
            )
          );
        }
      }
    }
    return findings;
  }
};
