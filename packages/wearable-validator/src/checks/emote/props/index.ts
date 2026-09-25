/** E-07 Props — prop geometry ships with every emote, so it carries its own triangle, material, texture and bone budget. */
import type { Document, Material, Node, Texture } from "@gltf-transform/core";
import { emoteOnly } from "../../../logic/animation.js";
import { colliderNodes } from "../../../logic/gltf.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { PROPS } from "../../docs.js";

const meta: CheckMeta = { name: "props", group: "emote", rule: "E-07", docs: `${PROPS}#the-basics-and-limitations` };

function findNodesNamed(doc: Document, name: string): Node[] {
  return doc.getRoot().listNodes().filter((n) => n.getName() === name);
}

function collectSubtree(root: Node, into: Set<Node>): void {
  if (into.has(root)) return;
  into.add(root);
  for (const child of root.listChildren()) collectSubtree(child, into);
}

export const props: CheckDefinition = {
  ...meta,
  title: "Props",
  describe: "prop stays within the triangle, material, texture and bone budgets",
  explanation: "Emote props are limited to 3,000 triangles, 2 materials, 2 textures and 62 bones.",
  fix: "Reduce the prop to 3,000 triangles, 2 materials and 2 textures, and parent it to an armature named 'Armature_Prop'.",
  details: "Measures the prop armature's subtree — triangles, materials, textures and bone count — against the prop budgets.",
  appliesTo: (ctx) => {
    const base = emoteOnly(ctx);
    if (base !== true) return base;
    if (ctx.models.length === 0) return true; // parse failures fall through to the runner's skip logic
    const propArmatureName = ctx.manifest.skeleton.propArmatureName;
    const hasProp = ctx.models.some((m) => findNodesNamed(m.doc, propArmatureName).length > 0);
    return hasProp ? true : `no "${propArmatureName}" armature — this emote carries no prop`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const { propMaxTriangles, propMaxMaterials, propMaxTextures, propMaxBones } = ctx.manifest.emote;
    const propArmatureName = ctx.manifest.skeleton.propArmatureName;
    for (const model of ctx.models) {
      const roots = findNodesNamed(model.doc, propArmatureName);
      if (roots.length === 0) continue;
      const nodes = new Set<Node>();
      for (const root of roots) collectSubtree(root, nodes);
      const colliders = colliderNodes(model.doc);
      let triangles = 0;
      const materials = new Set<Material>();
      const textures = new Set<Texture>();
      for (const node of nodes) {
        const mesh = node.getMesh();
        if (!mesh || colliders.has(node)) continue;
        for (const prim of mesh.listPrimitives()) {
          const mode = prim.getMode();
          const indices = prim.getIndices();
          const position = prim.getAttribute("POSITION");
          const vertexCount = indices ? indices.getCount() : position ? position.getCount() : 0;
          if (mode === 4) triangles += vertexCount / 3;
          else if (mode === 5 || mode === 6) triangles += Math.max(0, vertexCount - 2);
          const material = prim.getMaterial();
          if (material) {
            materials.add(material);
            const slots = [
              material.getBaseColorTexture(),
              material.getEmissiveTexture(),
              material.getNormalTexture(),
              material.getOcclusionTexture(),
              material.getMetallicRoughnessTexture()
            ];
            for (const tex of slots) if (tex) textures.add(tex);
          }
        }
      }
      triangles = Math.floor(triangles);
      const joints = new Set<Node>();
      for (const skin of model.doc.getRoot().listSkins()) {
        for (const joint of skin.listJoints()) if (nodes.has(joint)) joints.add(joint);
      }
      const where = `${model.mainFile} › ${propArmatureName}`;
      if (triangles > propMaxTriangles) {
        findings.push(
          finding(meta, "error", `The prop uses ${triangles} triangles — props are limited to ${propMaxTriangles}. Decimate the prop mesh.`, {
            where,
            measured: triangles,
            limit: propMaxTriangles,
            data: { metric: "triangles" }
          })
        );
      }
      if (materials.size > propMaxMaterials) {
        findings.push(
          finding(meta, "error", `The prop uses ${materials.size} materials — props are limited to ${propMaxMaterials}. Merge the prop's materials.`, {
            where,
            measured: materials.size,
            limit: propMaxMaterials,
            data: { metric: "materials" }
          })
        );
      }
      if (textures.size > propMaxTextures) {
        findings.push(
          finding(meta, "error", `The prop uses ${textures.size} textures — props are limited to ${propMaxTextures}. Combine the prop's textures into an atlas.`, {
            where,
            measured: textures.size,
            limit: propMaxTextures,
            data: { metric: "textures" }
          })
        );
      }
      if (joints.size > propMaxBones) {
        findings.push(
          finding(meta, "error", `The prop armature has ${joints.size} bones — props are limited to ${propMaxBones}. Simplify the prop rig.`, {
            where,
            measured: joints.size,
            limit: propMaxBones,
            data: { metric: "bones" }
          })
        );
      }
    }
    return findings;
  }
};
