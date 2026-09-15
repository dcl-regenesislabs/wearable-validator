/** Which files in an item count as its model files — shared by the format, validity and size checks. */
import type { CheckContext } from "../types.js";

/** Model-file candidates: parsed models ∪ representation mainFiles present ∪ (fallback) files ending .glb/.gltf. */
export function modelFileCandidates(ctx: CheckContext): string[] {
  const candidates = new Set<string>();
  for (const model of ctx.models) candidates.add(model.mainFile);
  for (const rep of ctx.item.representations ?? []) {
    if (ctx.files.has(rep.mainFile)) candidates.add(rep.mainFile);
  }
  if (candidates.size === 0) {
    for (const path of ctx.files.keys()) {
      if (path.endsWith(".glb") || path.endsWith(".gltf")) candidates.add(path);
    }
  }
  return [...candidates].sort();
}
