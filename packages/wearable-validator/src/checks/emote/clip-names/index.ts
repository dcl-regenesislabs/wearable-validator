/** E-06 Clip names — the runtime and Builder expect Capitalized_Words_With_Underscores clip names. */
import { emoteOnly } from "../../../logic/animation.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "clip-names", group: "emote", rule: "E-06", docs: `${EMOTES}#naming` };

export const clipNames: CheckDefinition = {
  ...meta,
  title: "Clip names",
  describe: "clip names start with a capital, use only letters/digits/underscores, and capitalize each word",
  explanation: "Animation names use Capitalized_Words_With_Underscores — no spaces or special characters.",
  fix: "Rename the action to Capitalized_Words_With_Underscores — no spaces or special characters (e.g. 'Party_Dance_Avatar').",
  details: "Checks the action names: capital first letter, underscores only; per-word capitalization is a warning.",
  appliesTo: emoteOnly,
  measure: (ctx) => {
    const names = ctx.models.flatMap((m) => m.doc.getRoot().listAnimations().map((a) => a.getName() || "(unnamed)"));
    return names.length > 0 ? names.slice(0, 2).join(", ") + (names.length > 2 ? "…" : "") : undefined;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      for (const anim of model.doc.getRoot().listAnimations()) {
        const name = anim.getName();
        const where = `${model.mainFile} › ${name}`;
        if (!/^[A-Z]/.test(name)) {
          findings.push(
            finding(meta, "error", `Clip name "${name}" must start with a capital letter (e.g. "Wave_Avatar"). Rename the clip.`, { where, data: { clip: name } })
          );
        }
        const invalid = [...new Set(name.match(/[^A-Za-z0-9_]/g) ?? [])];
        if (invalid.length > 0) {
          findings.push(
            finding(meta, "error", `Clip name "${name}" contains ${invalid.map((c) => JSON.stringify(c)).join(", ")} — use only letters, digits and underscores (no spaces or special characters).`, {
              where,
              data: { clip: name, characters: invalid }
            })
          );
        } else {
          const lowerWords = name.split("_").slice(1).filter((w) => /^[a-z]/.test(w));
          if (lowerWords.length > 0) {
            findings.push(
              finding(meta, "warning", `Each word in a clip name should start with a capital letter — lowercase after "_": ${lowerWords.join(", ")} (e.g. "Wave_Avatar", not "Wave_avatar").`, {
                where,
                data: { clip: name, words: lowerWords }
              })
            );
          }
        }
      }
    }
    return findings;
  }
};
