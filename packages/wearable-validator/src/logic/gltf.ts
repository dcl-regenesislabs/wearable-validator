import { Document, WebIO, type Node, type Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const io = new WebIO().registerExtensions(ALL_EXTENSIONS);

/** Parse a self-contained GLB. Returns the gltf-transform Document plus the raw JSON chunk. */
export async function parseGlb(bytes: Uint8Array): Promise<{ doc: Document; json: Record<string, unknown> }> {
  const json = readGlbJsonChunk(bytes);
  assertAcyclicNodes(json);
  const doc = await io.readBinary(bytes);
  return { doc, json };
}

function assertAcyclicNodes(json: Record<string, unknown>): void {
  if (!Array.isArray(json.nodes)) return;
  const nodes: unknown[] = json.nodes;
  const parents = new Uint32Array(nodes.length);
  const children = nodes.map((node) => {
    if (!node || typeof node !== "object" || !("children" in node)) return [];
    if (!Array.isArray(node.children)) throw new Error("The model has an invalid node hierarchy. Re-export it as GLB.");
    return node.children.map((child: unknown) => {
      if (typeof child !== "number" || !Number.isInteger(child) || child < 0 || child >= nodes.length) {
        throw new Error("The model references a missing child node. Re-export it as GLB.");
      }
      parents[child]++;
      return child;
    });
  });
  const ready: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (parents[i] === 0) ready.push(i);
  for (let next = 0; next < ready.length; next++) {
    for (const child of children[ready[next]]) if (--parents[child] === 0) ready.push(child);
  }
  if (ready.length !== nodes.length) throw new Error("The model contains a cycle in its node hierarchy. Re-export it as GLB.");
}

/** Reads the JSON chunk of a GLB container without a full parse (cameras/extensions live here). */
export function readGlbJsonChunk(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB container");
  const jsonLength = view.getUint32(12, true);
  const jsonBytes = bytes.subarray(20, 20 + jsonLength);
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>;
}

export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/** Collider rule (pinned): a mesh is a collider when its node — or any ancestor — matches /collider/i. */
export function isColliderNode(node: Node): boolean {
  const seen = new Set<Node>();
  let current: Node | null = node;
  while (current) {
    if (seen.has(current)) throw new Error("The model contains a cycle in its node hierarchy. Re-export it as GLB.");
    seen.add(current);
    if (/collider/i.test(current.getName())) return true;
    const parent = current.listParents().find((p) => p.propertyType === "Node") as Node | undefined;
    current = parent ?? null;
  }
  return false;
}

export interface TriangleCount {
  total: number;
  /** true when any STRIP/FAN primitive was counted (warn: non-standard export). */
  hasStripOrFan: boolean;
}

/** Pinned counting: mode-4 = indices/3 (non-indexed: positions/3); STRIP/FAN = n−2; colliders excluded. */
export function countTriangles(doc: Document): TriangleCount {
  let total = 0;
  let hasStripOrFan = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || isColliderNode(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      total += primitiveTriangles(prim, (m) => (m ? (hasStripOrFan = true) : undefined));
    }
  }
  // meshes not attached to any node still render nowhere; count only node-attached meshes (builder parity)
  return { total: Math.floor(total), hasStripOrFan };
}

function primitiveTriangles(prim: Primitive, markStripFan: (m: boolean) => void): number {
  const mode = prim.getMode();
  const indices = prim.getIndices();
  const position = prim.getAttribute("POSITION");
  const vertexCount = indices ? indices.getCount() : position ? position.getCount() : 0;
  if (mode === 4) return vertexCount / 3;
  if (mode === 5 || mode === 6) {
    markStripFan(true);
    return Math.max(0, vertexCount - 2);
  }
  return 0; // points/lines contribute no triangles
}

/** Rest-pose world AABB of node-transformed POSITION min/max; colliders excluded. */
export function computeAabb(doc: Document): { width: number; height: number; depth: number } | null {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || isColliderNode(node)) continue;
    const world = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const pMin = pos.getMin([0, 0, 0]);
      const pMax = pos.getMax([0, 0, 0]);
      // transform the 8 AABB corners — exact for affine transforms
      for (const x of [pMin[0], pMax[0]]) for (const y of [pMin[1], pMax[1]]) for (const z of [pMin[2], pMax[2]]) {
        const c = transformPoint(world, [x, y, z]);
        for (let i = 0; i < 3; i++) {
          if (c[i] < min[i]) min[i] = c[i];
          if (c[i] > max[i]) max[i] = c[i];
        }
        any = true;
      }
    }
  }
  if (!any) return null;
  return { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
}

function transformPoint(m: number[], p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

/** All joint names across all skins. */
export function listJointNames(doc: Document): string[] {
  const names = new Set<string>();
  for (const skin of doc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) names.add(joint.getName());
  }
  return [...names];
}

export function hasSkinnedMesh(doc: Document): boolean {
  return doc.getRoot().listNodes().some((n) => n.getMesh() && n.getSkin());
}

export function formatDimensions(box: { width: number; height: number; depth: number }): string {
  return `${[box.width, box.height, box.depth].map(value => Number(value.toPrecision(7))).join(" × ")} m`;
}
