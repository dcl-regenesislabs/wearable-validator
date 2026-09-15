/** S-09 Content integrity — catalysts address files by hash, so a file that drifts from its declared hash never deploys. */
import { contentHash } from "../../../logic/content-hash.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "content-integrity", group: "files", rule: "S-09", docs: `${UPLOADING}#uploading-your-file` };

export const contentIntegrity: CheckDefinition = {
  ...meta,
  title: "Content integrity",
  describe: "file contents match their declared legacy or CIDv1 hashes",
  explanation: "Each uploaded file's hash must match its content, proving nothing was altered or corrupted after export.",
  fix: "Re-upload the item — a file changed after its hash was computed. Never edit files inside the package after exporting.",
  details:
    "Recomputes each file's hash using its declared format: legacy Decentraland SHA-256 for Qm… hashes, or UnixFS CIDv1 for baf… hashes and compares it against the declared content list, both directions. Runs only when an entity content list is available (platform submissions and published items).",
  measure: (ctx) => (ctx.content ? `${ctx.content.length} files hashed` : undefined),
  appliesTo: (ctx) => (ctx.content ? true : "no entity content list"),
  run: async (ctx) => {
    const findings: Finding[] = [];
    const declared = new Map<string, string>();
    for (const entry of ctx.content ?? []) declared.set(entry.file, entry.hash);

    for (const [file, hash] of declared) {
      const bytes = ctx.files.get(file);
      if (!bytes) {
        findings.push(finding(meta, "error", `"${file}" is declared in the content list but the file is missing from the upload.`, { where: file }));
        continue;
      }
      const computed = await contentHash(bytes, hash.startsWith("Qm") ? 0 : 1);
      if (computed !== hash) {
        findings.push(
          finding(meta, "error", `"${file}" does not match its declared hash — the file changed after the content list was built. Rebuild the deployment.`, {
            where: file,
            measured: computed,
            limit: hash
          })
        );
      }
    }
    for (const file of ctx.files.keys()) {
      if (!declared.has(file)) {
        findings.push(finding(meta, "error", `"${file}" is in the upload but not declared in the content list — declare it or remove it.`, { where: file }));
      }
    }
    return findings;
  }
};
