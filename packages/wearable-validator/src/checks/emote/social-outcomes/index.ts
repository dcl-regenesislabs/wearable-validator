/** E-09 Social outcomes — social emotes may declare a few outcomes, each needing a clip that really exists in the GLB (ADR-287). */
import { emoteOnly } from "../../../logic/animation.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "social-outcomes", group: "emote", rule: "E-09", docs: `${EMOTES}#number-of-animations` };

function extractOutcomeClips(outcome: unknown): string[] {
  if (!outcome || typeof outcome !== "object") return [];
  const clips = (outcome as Record<string, unknown>).clips;
  if (Array.isArray(clips)) {
    const names: string[] = [];
    for (const clip of clips) {
      if (typeof clip === "string") names.push(clip);
      else if (clip && typeof clip === "object") {
        const name = (clip as Record<string, unknown>).clip ?? (clip as Record<string, unknown>).animation;
        if (typeof name === "string") names.push(name);
      }
    }
    return names;
  }
  if (clips && typeof clips === "object") {
    return Object.values(clips as Record<string, unknown>).filter((v): v is string => typeof v === "string");
  }
  return [];
}

export const socialOutcomes: CheckDefinition = {
  ...meta,
  title: "Social outcomes",
  describe: "social emote outcomes stay within the limit and reference clips that exist in the GLB",
  explanation: "Social emotes may define up to 3 outcomes, each pointing to an animation that exists in the file.",
  fix: "Define at most 3 outcomes and make each one point to an animation clip that exists in the GLB.",
  details: "When outcomes metadata exists: at most 3, each referencing an animation clip that actually exists in the GLB.",
  appliesTo: (ctx) => {
    const base = emoteOnly(ctx);
    if (base !== true) return base;
    const emoteData = ctx.item.emoteData;
    if (emoteData && (emoteData.outcomes !== undefined || emoteData.startAnimation !== undefined)) return true;
    return "not a social emote — metadata carries no outcomes or startAnimation";
  },
  measure: (ctx) => {
    const outcomes = ctx.item.emoteData?.outcomes;
    return outcomes ? `${outcomes.length} outcomes` : undefined;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxOutcomes = ctx.manifest.emote.maxSocialOutcomes;
    const emoteData = ctx.item.emoteData ?? {};
    const outcomes = Array.isArray(emoteData.outcomes) ? emoteData.outcomes : undefined;
    if (outcomes && outcomes.length > maxOutcomes) {
      findings.push(
        finding(meta, "error", `The emote declares ${outcomes.length} outcomes — social emotes may have at most ${maxOutcomes}. Remove the extra outcomes.`, {
          measured: outcomes.length,
          limit: maxOutcomes
        })
      );
    }
    if (emoteData.startAnimation != null && (!outcomes || outcomes.length === 0)) {
      findings.push(
        finding(meta, "error", "startAnimation is set but the emote has no outcomes — social emotes need both (ADR-287). Add outcomes or remove startAnimation.", {
          data: { hasOutcomes: false }
        })
      );
    }
    if (outcomes) {
      const clipNamesInGlb = new Set(ctx.models.flatMap((m) => m.doc.getRoot().listAnimations().map((a) => a.getName())));
      outcomes.forEach((outcome, index) => {
        for (const clip of extractOutcomeClips(outcome)) {
          if (!clipNamesInGlb.has(clip)) {
            findings.push(
              finding(
                meta,
                "error",
                `Outcome ${index + 1} references the clip "${clip}", which doesn't exist in the GLB (clips found: ${[...clipNamesInGlb].join(", ") || "none"}). Fix the clip name in the outcome.`,
                { where: clip, data: { outcome: index + 1 } }
              )
            );
          }
        }
      });
    }
    return findings;
  }
};
