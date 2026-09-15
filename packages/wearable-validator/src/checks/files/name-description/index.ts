/** S-07 Name & description — marketplace cards truncate long text and ':' breaks the URN-style identifiers built from names. */
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "name-description", group: "files", rule: "S-07", docs: `${UPLOADING}#description` };

export const nameDescription: CheckDefinition = {
  ...meta,
  title: "Name & description",
  describe: "name/description length, forbidden characters, tag count",
  explanation: "Names are limited to 32 characters and descriptions to 64, and neither may contain the ':' character.",
  fix: "Shorten the name (max 32 chars) or description (max 64) and remove any ':' characters.",
  details: "Plain string checks: name ≤32 characters, description ≤64, no ':' anywhere, at most 20 non-empty tags.",
  measure: (ctx) => {
    const parts: string[] = [];
    if (ctx.item.name !== undefined) parts.push(`name ${ctx.item.name.length}`);
    if (ctx.item.description !== undefined) parts.push(`description ${ctx.item.description.length}`);
    parts.push(`${ctx.item.tags?.length ?? 0} tags`);
    return parts.join(" · ");
  },
  appliesTo: (ctx) => (ctx.metadataMode === "none" ? "no metadata to carry a name or description" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const { nameMax, descriptionMax, forbiddenChars, tagsMax } = ctx.manifest.text;
    const fields: { label: string; value: string | undefined; max: number }[] = [
      { label: "name", value: ctx.item.name, max: nameMax },
      { label: "description", value: ctx.item.description, max: descriptionMax }
    ];
    for (const { label, value, max } of fields) {
      if (value === undefined) continue;
      if (value.length > max) {
        findings.push(
          finding(meta, "error", `The ${label} is ${value.length} characters; the maximum is ${max}. Shorten it.`, {
            where: label,
            measured: value.length,
            limit: max
          })
        );
      }
      for (const ch of forbiddenChars) {
        if (value.includes(ch)) {
          findings.push(finding(meta, "error", `The ${label} contains "${ch}", which is not allowed — remove it.`, { where: label, data: { character: ch } }));
        }
      }
    }
    const tags = (ctx.item.tags ?? []).filter((t) => t.trim() !== "");
    if (tags.length > tagsMax) {
      findings.push(
        finding(meta, "error", `The item has ${tags.length} tags; the maximum is ${tagsMax}. Remove some tags.`, {
          where: "tags",
          measured: tags.length,
          limit: tagsMax
        })
      );
    }
    return findings;
  }
};
