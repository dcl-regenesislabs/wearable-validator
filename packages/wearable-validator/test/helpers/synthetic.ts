import { Document, WebIO, type Node } from "@gltf-transform/core";
import { encode as encodePng } from "fast-png";
import JSZip from "jszip";
import { AVATAR_BONE_NAMES } from "../../src/manifest/index.js";

const io = new WebIO();

export interface SyntheticOptions {
  /** Triangles for the cube mesh (default 12 — a plain cube). */
  triangles?: number;
  /** Skin the mesh to the canonical skeleton (default true). */
  skinned?: boolean;
  /** Bone names to create (default: the canonical 62). */
  bones?: string[];
  /** Add an animation clip with this name + duration (seconds). */
  animation?: { name: string; seconds: number; loopSeam?: boolean; targetBone?: string };
  /** Add N extra materials/textures beyond the first. */
  extraMaterials?: number;
  texture?: { size: number; nonSquare?: boolean };
  /** Scale applied to the cube (bounding-box tests). */
  scale?: number;
}

/**
 * Builds a minimal valid wearable/emote GLB in memory: a cube skinned to the
 * canonical skeleton, one material, optional animation. Mutate via options —
 * every check's failing case is one option away.
 */
export async function syntheticGlb(options: SyntheticOptions = {}): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  const scale = options.scale ?? 1;
  const positions = cubePositions(scale, options.triangles ?? 12);
  const position = doc.createAccessor("POSITION").setType("VEC3").setArray(positions).setBuffer(buffer);

  const material = doc.createMaterial("Wearable_MAT");
  if (options.texture) {
    const size = options.texture.size;
    const tex = doc.createTexture("tex0").setMimeType("image/png").setImage(pngBytes(size, options.texture.nonSquare ? size / 2 : size));
    material.setBaseColorTexture(tex);
  }
  const prim = doc.createPrimitive().setMode(4).setAttribute("POSITION", position).setMaterial(material);
  const mesh = doc.createMesh("cube").addPrimitive(prim);
  const meshNode = doc.createNode("cube_node").setMesh(mesh);
  scene.addChild(meshNode);

  for (let i = 0; i < (options.extraMaterials ?? 0); i++) {
    const extra = doc.createMaterial(`Extra_MAT_${i}`);
    const extraPrim = doc.createPrimitive().setMode(4).setAttribute("POSITION", position).setMaterial(extra);
    mesh.addPrimitive(extraPrim);
  }

  const boneNames = options.bones ?? AVATAR_BONE_NAMES;
  let boneNodes: Node[] = [];
  if (options.skinned !== false) {
    const armature = doc.createNode("Armature");
    scene.addChild(armature);
    boneNodes = boneNames.map((name) => doc.createNode(name));
    // flat hierarchy under Armature — enough for joint-name checks
    for (const b of boneNodes) armature.addChild(b);
    const skin = doc.createSkin("skin");
    for (const b of boneNodes) skin.addJoint(b);
    meshNode.setSkin(skin);
    const vertexCount = positions.length / 3;
    const joints = new Uint16Array(vertexCount * 4);
    const weights = new Float32Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) weights[v * 4] = 1; // fully weighted to bone 0
    prim.setAttribute("JOINTS_0", doc.createAccessor("JOINTS_0").setType("VEC4").setArray(joints).setBuffer(buffer));
    prim.setAttribute("WEIGHTS_0", doc.createAccessor("WEIGHTS_0").setType("VEC4").setArray(weights).setBuffer(buffer));
  }

  if (options.animation) {
    const { name, seconds, loopSeam, targetBone } = options.animation;
    const target = boneNodes.find((b) => b.getName() === (targetBone ?? "Avatar_Hips")) ?? meshNode;
    const times = new Float32Array([0, seconds / 2, seconds]);
    const lastY = loopSeam ? 0 : 0.5; // loopSeam=true → clean loop (first == last)
    const values = new Float32Array([0, 0, 0, 0, 0.25, 0, 0, lastY, 0]);
    const input = doc.createAccessor("times").setType("SCALAR").setArray(times).setBuffer(buffer);
    const output = doc.createAccessor("values").setType("VEC3").setArray(values).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
    const channel = doc.createAnimationChannel().setTargetNode(target).setTargetPath("translation").setSampler(sampler);
    doc.createAnimation(name).addSampler(sampler).addChannel(channel);
  }

  return io.writeBinary(doc);
}

function cubePositions(scale: number, triangles: number): Float32Array {
  // `triangles` non-indexed triangles inside a cube of side `scale`
  const arr = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const jitter = (t % 12) * 0.01;
    arr[o] = 0; arr[o + 1] = 0; arr[o + 2] = jitter;
    arr[o + 3] = scale; arr[o + 4] = 0; arr[o + 5] = jitter;
    arr[o + 6] = 0; arr[o + 7] = scale; arr[o + 8] = jitter;
  }
  return arr;
}

/** A solid PNG (RGBA) — transparent border ring so thumbnail transparency passes by default. */
export function pngBytes(width: number, height: number, opaque = false): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 200; data[i + 1] = 60; data[i + 2] = 90;
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      data[i + 3] = !opaque && border ? 0 : 255;
    }
  }
  return encodePng({ width, height, data });
}

export interface SyntheticZipOptions {
  glb?: Uint8Array;
  kind?: "wearable" | "emote";
  manifest?: Record<string, unknown>;
  thumbnail?: Uint8Array | null;
  extraFiles?: Record<string, Uint8Array>;
}

/** A builder-style zip: model.glb + wearable.json/emote.json + thumbnail.png. */
export async function syntheticZip(options: SyntheticZipOptions = {}): Promise<Uint8Array> {
  const kind = options.kind ?? "wearable";
  const glb = options.glb ?? (await syntheticGlb(kind === "emote" ? { animation: { name: "Pose_Avatar", seconds: 2 } } : {}));
  const manifest =
    options.manifest ??
    (kind === "wearable"
      ? { name: "Test Wearable", description: "synthetic", rarity: "common", data: { category: "hat", tags: ["test"], hides: [], replaces: [], representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale", "urn:decentraland:off-chain:base-avatars:BaseFemale"], mainFile: "model.glb", contents: ["model.glb"] }] } }
      : { name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: "simple" });
  const zip = new JSZip();
  zip.file("model.glb", glb);
  zip.file(kind === "wearable" ? "wearable.json" : "emote.json", JSON.stringify(manifest));
  const thumb = options.thumbnail === null ? undefined : options.thumbnail ?? pngBytes(256, 256);
  if (thumb) zip.file("thumbnail.png", thumb);
  for (const [path, bytes] of Object.entries(options.extraFiles ?? {})) zip.file(path, bytes);
  return zip.generateAsync({ type: "uint8array" });
}
