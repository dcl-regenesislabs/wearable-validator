/** S-08 Category — the category decides the slot, hides/replaces and limits; base body shapes are not collection items. */
import { EmoteCategory, WearableCategory } from "@dcl/schemas";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "category", group: "files", rule: "S-08", docs: `${UPLOADING}#category` };

// Object.values also yields the namespace's schema/validate members — keep only the enum strings.
const WEARABLE_CATEGORY_VALUES: Set<string> = new Set(
  Object.values(WearableCategory).filter((v): v is WearableCategory => typeof v === "string")
);

export const category: CheckDefinition = {
  ...meta,
  title: "Category",
  describe: "known category; body_shape is not submittable",
  explanation: "The item must declare a valid category (hat, upper body, feet…). Base body shapes can't be published as wearables.",
  fix: "Pick a valid wearable slot (hat, upper body, feet…) or emote category (dance, fun, greetings…) in the Builder. Base body shapes can't be published.",
  details: "The declared category must belong to the platform enum for the item type: wearable slots or emote categories. Base body shapes cannot be submitted as wearables.",
  measure: (ctx) => ctx.category,
  appliesTo: (ctx) => (ctx.metadataMode === "none" && !ctx.category ? "no metadata or category hint" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    if (ctx.itemType === "emote") {
      const emoteCategory = ctx.item.emoteData?.category ?? ctx.item.category ?? ctx.category;
      if (!EmoteCategory.validate(emoteCategory)) {
        findings.push(finding(meta, "error", `Unknown or missing emote category "${emoteCategory ?? ""}" — choose a supported category such as dance, fun, or greetings.`, { where: "category", measured: String(emoteCategory ?? "") }));
      }
      return findings;
    }
    const value = ctx.category;
    if (!value) return findings; // missing category is S-03's finding
    if (value === "body_shape") {
      findings.push(
        finding(meta, "error", 'The category "body_shape" cannot be submitted as a collection item — pick the slot the item actually occupies.', {
          measured: value
        })
      );
    } else if (!WEARABLE_CATEGORY_VALUES.has(value)) {
      findings.push(
        finding(meta, "error", `Unknown category "${value}" — valid categories are: ${[...WEARABLE_CATEGORY_VALUES].filter((c) => c !== "body_shape").join(", ")}.`, {
          measured: value
        })
      );
    }
    return findings;
  }
};
