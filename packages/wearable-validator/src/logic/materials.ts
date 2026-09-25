/** Material/texture bookkeeping shared by the model checks and their measures — colliders never count. */
import type { Document, Material, Texture } from "@gltf-transform/core";
import { colliderNodes } from "./gltf.js";

/** Materials that count toward limits: used by primitives of meshes on non-collider nodes. */
export function countedMaterials(doc: Document): Material[] {
  const set = new Set<Material>();
  const colliders = colliderNodes(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat) set.add(mat);
    }
  }
  return [...set];
}

export function textureName(tex: Texture, index: number): string {
  return tex.getName() || tex.getURI() || `texture #${index}`;
}
