/** S-04 Representations — an item renders only on the body shapes it ships a model for, and every listed file must exist. */
import { BodyShape } from "@dcl/schemas";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "representations", group: "files", rule: "S-04", docs: `${UPLOADING}#adding-another-representation` };

export const representations: CheckDefinition = {
  ...meta,
  title: "Representations",
  describe: "≥1 body-shape representation; mainFile and listed contents exist",
  explanation: "The item must include a model for the body shapes it supports, and every listed file must be present in the upload.",
  fix: "Use the canonical BaseMale/BaseFemale URNs and make sure every body shape you support has its model file inside the package, and that every file listed in the manifest actually exists — re-export the item from the Builder.",
  details:
    "Set-compares both directions: every file a representation lists must exist in the upload, and its mainFile must be among them. At least one representation is required, and each body shape must be the canonical BaseMale or BaseFemale URN.",
  measure: (ctx) => {
    const reps = ctx.item.representations ?? [];
    if (reps.length === 0) return undefined;
    const shapes = new Set(reps.flatMap((r) => r.bodyShapes.map((s) => (s === BodyShape.FEMALE ? "female" : s === BodyShape.MALE ? "male" : `unknown: ${s}`))));
    return `${shapes.size} body shape${shapes.size > 1 ? "s" : ""} (${[...shapes].join(", ")})`;
  },
  appliesTo: (ctx) => {
    if (ctx.inputKind === "glb" || ctx.inputKind === "png-set") return "bare inputs carry no representations metadata";
    if (ctx.metadataMode === "none") return "no metadata (representations live in the item metadata)";
    return true;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const reps = ctx.item.representations ?? [];
    if (reps.length === 0) {
      findings.push(finding(meta, "error", "The item declares no body-shape representation — it needs at least one (BaseMale and/or BaseFemale)."));
      return findings;
    }
    reps.forEach((rep, index) => {
      const where = rep.bodyShapes.join(", ") || `representation ${index + 1}`;
      if (rep.bodyShapes.length === 0) {
        findings.push(finding(meta, "error", `Representation ${index + 1} lists no body shapes — every representation needs at least one.`, { where: `representation ${index + 1}` }));
      }
      for (const shape of rep.bodyShapes) {
        if (!BodyShape.validate(shape)) {
          findings.push(finding(meta, "error", `Unknown body shape "${shape}" — use BaseMale or BaseFemale's full body-shape URN.`, { where, measured: String(shape), limit: `${BodyShape.MALE} or ${BodyShape.FEMALE}` }));
        }
      }
      if (!rep.contents.includes(rep.mainFile)) {
        findings.push(finding(meta, "error", `Representation "${where}" has mainFile "${rep.mainFile}" but does not list it in its contents.`, { where }));
      }
      if (!ctx.files.has(rep.mainFile)) {
        findings.push(finding(meta, "error", `Representation "${where}" points at "${rep.mainFile}" but that file is not in the item.`, { where }));
      }
      for (const content of rep.contents) {
        if (content !== rep.mainFile && !ctx.files.has(content)) {
          findings.push(finding(meta, "error", `Representation "${where}" lists "${content}" in its contents but that file is not in the item.`, { where }));
        }
      }
    });
    return findings;
  }
};
