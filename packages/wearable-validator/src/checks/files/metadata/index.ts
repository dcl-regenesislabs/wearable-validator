/** S-03 Metadata — the marketplace and backpack show what the metadata says, so it must be complete and match the platform schema. */
import { Rarity } from "@dcl/schemas";
import { metadataSchemaFindings } from "../../../logic/metadata-schema.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "metadata", group: "files", rule: "S-03", docs: `${UPLOADING}#properties` };

const MANIFEST_FILE_NAMES = ["wearable.json", "emote.json"];

function divergentFields(ctx: CheckContext): string[] {
  const embedded = ctx.embeddedManifest;
  if (!embedded) return [];
  const item = ctx.item;
  const fields: string[] = [];
  const scalar = (name: string, a: string | undefined, b: string | undefined) => {
    if (a !== undefined && b !== undefined && a !== b) fields.push(name);
  };
  scalar("name", item.name, embedded.name);
  scalar("description", item.description, embedded.description);
  scalar("rarity", item.rarity, embedded.rarity);
  scalar("category", item.category ?? item.emoteData?.category, embedded.category ?? embedded.emoteData?.category);
  for (const key of ["tags", "hides", "replaces"] as const) {
    const a = item[key];
    const b = embedded[key];
    if (a && b && JSON.stringify(a) !== JSON.stringify(b)) fields.push(key);
  }
  return fields;
}

export const metadata: CheckDefinition = {
  ...meta,
  title: "Metadata",
  describe: "supplied item matches its platform schema; Builder manifests have required fields",
  explanation: "The item's information — name, category, rarity — must be complete and valid.",
  fix: "Correct each reported field in the item metadata supplied by Builder or the server. Use the reported path, current value, and requirement; supply all required item fields and one translation per locale. For Builder ZIPs, fill in name/category and correct any supplied rarity, or re-export the item.",
  details:
    "Validates supplied item metadata with the official Wearable.validate or Emote.validate schema, including required fields, nested representations, and unique locale codes. Reports invalid field paths and values. Builder manifests use name/category and supplied-rarity checks. Differences between supplied metadata and the embedded manifest are flagged.",
  measure: (ctx) => (ctx.metadataMode === "entity" ? "entity metadata" : ctx.metadataMode === "builder" ? "builder manifest" : "no metadata"),
  appliesTo: (ctx) => (ctx.inputKind === "glb" || ctx.inputKind === "png-set" ? "bare inputs carry no metadata" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    if (ctx.metadataMode === "none") {
      findings.push(
        finding(
          meta,
          "error",
          ctx.inputKind === "zip"
            ? "No wearable.json or emote.json found in the zip — export the item from the Builder so its metadata travels with it."
            : "No metadata provided — pass the entity metadata or include a wearable.json/emote.json in the files."
        )
      );
      return findings;
    }

    for (const name of MANIFEST_FILE_NAMES) {
      const bytes = ctx.files.get(name);
      if (!bytes) continue;
      try {
        JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        findings.push(finding(meta, "error", `"${name}" is not valid JSON — re-export the item from the Builder.`, { where: name }));
      }
    }

    if (ctx.metadataMode === "entity") findings.push(...metadataSchemaFindings(ctx.entityMetadata, ctx.itemType, meta.docs));

    if (ctx.metadataMode === "builder" && ctx.item.rarity !== undefined && !Rarity.validate(ctx.item.rarity)) {
      findings.push(finding(meta, "error", `Unknown rarity "${ctx.item.rarity}" — choose a valid item rarity in the Builder.`, { where: "rarity", measured: String(ctx.item.rarity) }));
    }
    if (typeof ctx.item.name !== "string" || !ctx.item.name.trim()) {
      findings.push(finding(meta, "error", "The item has no name — give it a name before publishing."));
    }
    const category = ctx.itemType === "emote" ? ctx.item.emoteData?.category ?? ctx.item.category : ctx.item.category;
    if (!category) {
      findings.push(finding(meta, "error", `The ${ctx.itemType} declares no category — set one in the item metadata.`));
    }

    if (ctx.metadataMode === "entity" && ctx.embeddedManifest) {
      const fields = divergentFields(ctx);
      if (fields.length > 0) {
        findings.push(
          finding(
            meta,
            "warning",
            `The provided metadata and the zip's embedded manifest disagree on: ${fields.join(", ")}. The provided metadata was used; the embedded manifest was ignored.`,
            { data: { fields } }
          )
        );
      }
    }
    return findings;
  }
};
