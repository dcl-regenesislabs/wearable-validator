/** S-02 glTF validity — a corrupt or truncated GLB never loads, so the container is verified byte by byte. */
import { isGlb } from "../../../logic/gltf.js";
import { isFacial } from "../../../logic/facial.js";
import { modelFileCandidates } from "../../../logic/model-files.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "gltf-valid", group: "files", rule: "S-02", docs: `${WEARABLES}#building-3d-models-for-wearables` };

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"

// TODO(S-02): full glTF spec conformance via @dcl/gltf-validator-ts (severity policy in
// manifest.gltf) — this covers GLB container integrity + loader parse errors only.
function glbContainerFindings(path: string, bytes: Uint8Array): Finding[] {
  const out: Finding[] = [];
  const err = (message: string) => out.push(finding(meta, "error", message, { where: path }));
  if (bytes.length < 20) {
    err(`"${path}" is truncated (${bytes.length} bytes) — a GLB needs a 12-byte header plus a JSON chunk. Re-export the model.`);
    return out;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    err(`"${path}" does not start with the GLB magic bytes — the file is not a glTF 2.0 binary.`);
    return out;
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    err(`"${path}" declares glTF version ${version} — only glTF 2.0 is supported. Re-export with a current exporter.`);
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.length) {
    err(`"${path}" declares a length of ${declaredLength} bytes but the file is ${bytes.length} bytes — the file is corrupt or truncated. Re-export it.`);
  }
  let offset = 12;
  let first = true;
  while (offset + 8 <= bytes.length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    if (offset + 8 + chunkLength > bytes.length) {
      err(`"${path}" has a chunk at byte ${offset} that runs past the end of the file — the file is corrupt or truncated.`);
      return out;
    }
    if (first) {
      if (chunkType !== GLB_CHUNK_JSON) {
        err(`"${path}"'s first chunk is not the JSON chunk — the GLB container is malformed.`);
        return out;
      }
      try {
        JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + chunkLength)));
      } catch {
        err(`"${path}"'s JSON chunk is not valid JSON — the file is corrupt. Re-export the model.`);
      }
      first = false;
    }
    offset += 8 + chunkLength;
  }
  return out;
}

export const gltfValid: CheckDefinition = {
  ...meta,
  title: "glTF validity",
  describe: "GLB container is well-formed and the model parses",
  explanation: "The 3D file must be valid and readable. Corrupt or incomplete exports can't be loaded by the engine.",
  fix: "Re-export the model from Blender — the file is corrupt or was cut off mid-export. If it keeps failing, re-import the .glb into a fresh Blender scene to find what breaks.",
  details: "Verifies the GLB container byte by byte — magic, version 2, declared length, chunk layout — and surfaces model-parser failures as findings.",
  measure: (ctx) => (ctx.models.length > 0 ? `${ctx.models.length} GLB${ctx.models.length > 1 ? "s" : ""} parsed` : undefined),
  appliesTo: (ctx) => (isFacial(ctx) ? "facial-feature wearables carry no GLB model" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const path of modelFileCandidates(ctx)) {
      const bytes = ctx.files.get(path);
      if (bytes && isGlb(bytes)) findings.push(...glbContainerFindings(path, bytes));
    }
    if (ctx.parseError) {
      findings.push(finding(meta, "error", `The model failed to parse: ${ctx.parseError}.`));
    }
    return findings;
  }
};
