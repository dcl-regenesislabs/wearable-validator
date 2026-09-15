/** M-12 Hides/replaces — self-hides are ignored by the engine, and skins must hide the full ADR-60 set to override the body. */
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "hides-replaces", group: "model", rule: "M-12", docs: `${UPLOADING}#overrides` };

export const hidesReplaces: CheckDefinition = {
  ...meta,
  title: "Hides/replaces",
  describe: "hides/replaces don't include the item's own category; skins hide the full ADR-60 set.",
  explanation: "The hides and replaces lists must make sense — hiding or replacing your own category is redundant (the engine ignores it), and skins are expected to hide the standard set of slots.",
  fix: "Remove the item's own category from hides/replaces (the engine ignores it anyway), and double-check the hidden slots make sense for the design.",
  details: "Checks the hides/replaces lists: hiding your own category fails; skins are expected to hide the standard slot set (a warning when incomplete).",
  categoryDependent: true,
  appliesTo: (ctx) => {
    const base = wearableGeometryOnly(ctx);
    if (base !== true) return base;
    if (ctx.metadataMode === "none") return "no metadata — hides/replaces come from the item manifest";
    return true;
  },
  measure: (ctx) => `hides ${ctx.item.hides?.length ?? 0} · replaces ${ctx.item.replaces?.length ?? 0}`,
  run: (ctx) => {
    const findings: Finding[] = [];
    const category = ctx.category!;
    const hides = ctx.item.hides ?? [];
    const replaces = ctx.item.replaces ?? [];
    if (hides.includes(category)) {
      findings.push(
        finding(meta, "warning",
          `hides includes the item's own category "${category}" — the engine ignores a self-hide, so it's harmless but redundant. Remove "${category}" from hides.`,
          { measured: category, data: { category, hides } })
      );
    }
    if (replaces.includes(category)) {
      findings.push(
        finding(meta, "warning",
          `replaces includes the item's own category "${category}" — the engine ignores a self-replace (replaces is deprecated by ADR-239), so it's harmless but redundant. Remove "${category}" from replaces.`,
          { measured: category, data: { category, replaces } })
      );
    }
    if (category === "skin") {
      const missing = ctx.manifest.skinAutoHideSet.filter((slot) => !hides.includes(slot));
      if (missing.length > 0) {
        findings.push(
          finding(meta, "warning",
            `Skins should hide the full avatar (ADR-60) — hides is missing: ${missing.join(", ")}. Add them so the skin overrides every base category.`,
            { data: { missing } })
        );
      }
    }
    return findings;
  }
};
