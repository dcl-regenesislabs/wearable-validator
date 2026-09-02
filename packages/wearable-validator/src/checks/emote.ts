import type { Animation, AnimationChannel, AnimationSampler, Document, Material, Node, Texture } from "@gltf-transform/core";
import { parseBuffer } from "music-metadata";
import { isColliderNode } from "../gltf.js";
import { AVATAR_BONE_NAME_SET } from "../manifest/index.js";
import { docsUrl, type CheckContext, type CheckDefinition, type Finding, type ParsedModel, type Severity } from "../types.js";

// Audio format lists are structural (rule E-08), not tunable limits — they live here, next to the manifest numbers.
const VALID_AUDIO_EXTENSIONS = [".mp3", ".ogg"];
const AUDIO_LIKE_EXTENSIONS = [".mp3", ".ogg", ".wav", ".aac", ".m4a", ".flac", ".opus", ".wma"];
const AUDIO_MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg" };

function emoteFinding(check: string, rule: string, severity: Severity, message: string, extra: Partial<Finding> = {}): Finding {
  return { check, group: "emote", severity, message, rule, docs: docsUrl(check), ...extra };
}

function emoteOnly(ctx: CheckContext): true | string {
  return ctx.itemType === "emote" ? true : "emote-only check — this item is a wearable";
}

interface ChannelKeys {
  sampler: AnimationSampler;
  count: number;
}

function channelKeys(channel: AnimationChannel): ChannelKeys | null {
  const sampler = channel.getSampler();
  const input = sampler?.getInput();
  if (!sampler || !input) return null;
  return { sampler, count: input.getCount() };
}

function keyTime(keys: ChannelKeys, index: number): number {
  return keys.sampler.getInput()!.getElement(index, [0])[0];
}

/** Output value at a key — CUBICSPLINE stores in-tangent/value/out-tangent per key, so pick the middle element. */
function keyValue(keys: ChannelKeys, index: number, components: number): number[] {
  const output = keys.sampler.getOutput();
  if (!output) return new Array<number>(components).fill(0);
  const stride = keys.sampler.getInterpolation() === "CUBICSPLINE" ? 3 : 1;
  return output.getElement(index * stride + (stride === 3 ? 1 : 0), new Array<number>(components).fill(0));
}

function clipDuration(anim: Animation): number {
  let max = 0;
  for (const channel of anim.listChannels()) {
    const keys = channelKeys(channel);
    if (!keys) continue;
    for (let i = 0; i < keys.count; i++) {
      const t = keyTime(keys, i);
      if (t > max) max = t;
    }
  }
  return max;
}

function parentNode(node: Node): Node | null {
  return (node.listParents().find((p) => p.propertyType === "Node") as Node | undefined) ?? null;
}

function isUnderNodeNamed(node: Node, name: string): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.getName() === name) return true;
    current = parentNode(current);
  }
  return false;
}

function findNodesNamed(doc: Document, name: string): Node[] {
  return doc.getRoot().listNodes().filter((n) => n.getName() === name);
}

function collectSubtree(root: Node, into: Set<Node>): void {
  if (into.has(root)) return;
  into.add(root);
  for (const child of root.listChildren()) collectSubtree(child, into);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function applyMat4(m: number[], p: number[]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;

const duration: CheckDefinition = {
  name: "duration",
  group: "emote",
  rule: "E-01",
  title: "Duration",
  describe: "animation length within the emote limit; ~30 fps keyframe spacing advisory",
  appliesTo: emoteOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const { maxDurationSeconds, expectedFps, fpsTolerance } = ctx.manifest.emote;
    for (const model of ctx.models) {
      const anims = model.doc.getRoot().listAnimations();
      if (anims.length === 0) continue;
      let measured = 0;
      const deltas: number[] = [];
      for (const anim of anims) {
        for (const channel of anim.listChannels()) {
          const keys = channelKeys(channel);
          if (!keys) continue;
          let prev: number | null = null;
          for (let i = 0; i < keys.count; i++) {
            const t = keyTime(keys, i);
            if (t > measured) measured = t;
            if (prev !== null && t > prev) deltas.push(t - prev);
            prev = t;
          }
        }
      }
      if (measured > maxDurationSeconds) {
        findings.push(
          emoteFinding("duration", "E-01", "error", `The animation runs ${round3(measured)} s — emotes must fit in ${maxDurationSeconds} s. Trim or speed up the clip.`, {
            where: model.mainFile,
            measured: round3(measured),
            limit: maxDurationSeconds
          })
        );
      }
      const median = medianOf(deltas);
      if (median !== null && median > 0) {
        const fps = 1 / median;
        if (Math.abs(fps - expectedFps) > fpsTolerance) {
          findings.push(
            emoteFinding(
              "duration",
              "E-01",
              "warning",
              `Keyframe spacing suggests ~${round1(fps)} fps — emotes are expected around ${expectedFps} fps (±${fpsTolerance}). Re-export the animation sampled at ${expectedFps} fps.`,
              { where: model.mainFile, measured: round1(fps), limit: `${expectedFps}±${fpsTolerance} fps`, data: { advisory: true } }
            )
          );
        }
      }
    }
    return findings;
  }
};

const animationClips: CheckDefinition = {
  name: "animation-clips",
  group: "emote",
  rule: "E-02",
  title: "Animation clips",
  describe: "one avatar clip plus an optional prop clip; _Avatar/_Prop suffixes and equal lengths when both exist",
  appliesTo: emoteOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const { maxClipsWithProps, propClipLengthToleranceSeconds } = ctx.manifest.emote;
    for (const model of ctx.models) {
      const anims = model.doc.getRoot().listAnimations();
      const names = anims.map((a) => a.getName());
      if (anims.length === 0) {
        findings.push(
          emoteFinding("animation-clips", "E-02", "error", "No animation clips found — an emote GLB must contain the animation (one clip, or an _Avatar + _Prop pair).", {
            where: model.mainFile,
            measured: 0
          })
        );
        continue;
      }
      if (anims.length > maxClipsWithProps) {
        findings.push(
          emoteFinding(
            "animation-clips",
            "E-02",
            "error",
            `${anims.length} animation clips found — an emote may have at most ${maxClipsWithProps} (one "_Avatar" clip plus an optional "_Prop" clip). Merge or remove the extras.`,
            { where: model.mainFile, measured: anims.length, limit: maxClipsWithProps, data: { clips: names } }
          )
        );
      }
      if (anims.length >= 2) {
        const avatar = anims.find((a) => a.getName().endsWith("_Avatar"));
        const prop = anims.find((a) => a.getName().endsWith("_Prop"));
        if (!avatar || !prop) {
          findings.push(
            emoteFinding(
              "animation-clips",
              "E-02",
              "error",
              `With ${anims.length} clips, one must end in "_Avatar" and one in "_Prop" — found: ${names.join(", ")}. Rename the clips.`,
              { where: model.mainFile, data: { clips: names } }
            )
          );
        } else {
          const avatarSeconds = clipDuration(avatar);
          const propSeconds = clipDuration(prop);
          if (Math.abs(avatarSeconds - propSeconds) > propClipLengthToleranceSeconds) {
            findings.push(
              emoteFinding(
                "animation-clips",
                "E-02",
                "error",
                `The prop clip "${prop.getName()}" runs ${round3(propSeconds)} s but the avatar clip "${avatar.getName()}" runs ${round3(avatarSeconds)} s — both clips must have the same length (within ${propClipLengthToleranceSeconds} s). Re-export them with matching frame ranges.`,
                { where: model.mainFile, measured: round3(propSeconds), limit: round3(avatarSeconds), data: { clips: [prop.getName(), avatar.getName()] } }
              )
            );
          }
        }
      }
    }
    return findings;
  }
};

const boneTargets: CheckDefinition = {
  name: "bone-targets",
  group: "emote",
  rule: "E-03",
  title: "Bone targets",
  describe: "animation channels target only canonical avatar bones, spring bones, or prop bones from prop clips",
  appliesTo: emoteOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const springToken = ctx.manifest.skeleton.springBoneToken.toLowerCase();
    const propArmatureName = ctx.manifest.skeleton.propArmatureName;
    for (const model of ctx.models) {
      const seen = new Set<string>();
      for (const anim of model.doc.getRoot().listAnimations()) {
        const clipName = anim.getName();
        const isPropClip = clipName.endsWith("_Prop");
        for (const channel of anim.listChannels()) {
          const target = channel.getTargetNode();
          if (!target) continue;
          const name = target.getName();
          if (AVATAR_BONE_NAME_SET.has(name)) continue;
          if (name.toLowerCase().includes(springToken)) continue;
          const underProp = isUnderNodeNamed(target, propArmatureName);
          if (underProp && isPropClip) continue;
          const key = `${clipName}::${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const where = `${model.mainFile} › ${name}`;
          if (target.getMesh()) {
            findings.push(
              emoteFinding("bone-targets", "E-03", "error", `Clip "${clipName}" animates the mesh node "${name}" — emotes may only animate avatar bones, never meshes or objects. Remove the object animation and animate the skeleton instead.`, {
                where,
                data: { clip: clipName, node: name }
              })
            );
          } else if (underProp) {
            findings.push(
              emoteFinding("bone-targets", "E-03", "error", `Clip "${clipName}" animates the prop bone "${name}" — bones under "${propArmatureName}" may only be animated from a clip ending in "_Prop". Move those keys to the prop clip.`, {
                where,
                data: { clip: clipName, node: name }
              })
            );
          } else {
            findings.push(
              emoteFinding("bone-targets", "E-03", "error", `Clip "${clipName}" animates "${name}", which is not a canonical Avatar_* bone. Retarget the animation to the Decentraland skeleton (check the bone name's exact casing).`, {
                where,
                data: { clip: clipName, node: name }
              })
            );
          }
        }
      }
    }
    return findings;
  }
};

const loopSeam: CheckDefinition = {
  name: "loop-seam",
  group: "emote",
  rule: "E-04",
  title: "Loop seam",
  describe: "looping emotes end in the pose they start in — no visible snap at the loop point",
  appliesTo: (ctx) => {
    const base = emoteOnly(ctx);
    if (base !== true) return base;
    return ctx.item.loop === true ? true : "loop-seam only applies to looping emotes (loop is not true)";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const { loopSeamTranslation, loopSeamQuaternionDot, loopSeamScale } = ctx.manifest.epsilons;
    for (const model of ctx.models) {
      const offenders = new Set<string>();
      for (const anim of model.doc.getRoot().listAnimations()) {
        for (const channel of anim.listChannels()) {
          const path = channel.getTargetPath();
          if (path !== "translation" && path !== "rotation" && path !== "scale") continue;
          const keys = channelKeys(channel);
          if (!keys || keys.count < 2) continue;
          const components = path === "rotation" ? 4 : 3;
          const first = keyValue(keys, 0, components);
          const last = keyValue(keys, keys.count - 1, components);
          let seam = false;
          if (path === "rotation") {
            const dot = Math.abs(first[0] * last[0] + first[1] * last[1] + first[2] * last[2] + first[3] * last[3]);
            seam = dot < loopSeamQuaternionDot;
          } else {
            const dist = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
            seam = dist > (path === "translation" ? loopSeamTranslation : loopSeamScale);
          }
          if (seam) offenders.add(channel.getTargetNode()?.getName() ?? "(unnamed node)");
        }
      }
      if (offenders.size > 0) {
        const bones = [...offenders];
        const shown = bones.slice(0, 5);
        const more = bones.length > 5 ? ` (+${bones.length - 5} more)` : "";
        findings.push(
          emoteFinding("loop-seam", "E-04", "warning", `This looping emote ends in a different pose than it starts — the loop will visibly snap on ${shown.join(", ")}${more}. Match the first and last keyframes of those bones.`, {
            where: model.mainFile,
            data: { bones: shown }
          })
        );
      }
    }
    return findings;
  }
};

const rootMotion: CheckDefinition = {
  name: "root-motion",
  group: "emote",
  rule: "E-05",
  title: "Root motion",
  describe: "hips displacement stays within the allowed horizontal radius and vertical range",
  appliesTo: emoteOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const rm = ctx.manifest.emote.rootMotion;
    const hipsPattern = new RegExp(rm.hipsPattern, "i");
    for (const model of ctx.models) {
      const hipChannels: { keys: ChannelKeys; node: Node }[] = [];
      for (const anim of model.doc.getRoot().listAnimations()) {
        for (const channel of anim.listChannels()) {
          if (channel.getTargetPath() !== "translation") continue;
          const node = channel.getTargetNode();
          if (!node || !hipsPattern.test(node.getName())) continue;
          const keys = channelKeys(channel);
          if (!keys || keys.count === 0) continue;
          hipChannels.push({ keys, node });
        }
      }
      if (hipChannels.length === 0) continue;
      const preferred = hipChannels.filter((c) => c.node.getName() === "Avatar_Hips");
      const used = preferred.length > 0 ? preferred : hipChannels;
      let horizontal = 0;
      let vertical = 0;
      for (const { keys, node } of used) {
        const parent = parentNode(node);
        const world = parent ? parent.getWorldMatrix() : IDENTITY;
        let base: [number, number, number] | null = null;
        for (let i = 0; i < keys.count; i++) {
          const p = applyMat4(world, keyValue(keys, i, 3));
          if (!base) {
            base = p;
            continue;
          }
          const h = Math.hypot(p[0] - base[0], p[2] - base[2]);
          if (h > horizontal) horizontal = h;
          const v = Math.abs(p[1] - base[1]);
          if (v > vertical) vertical = v;
        }
      }
      if (horizontal > rm.horizontalErrorMeters) {
        findings.push(
          emoteFinding("root-motion", "E-05", "error", `The hips travel ${round3(horizontal)} m horizontally — emotes must stay within a ${rm.horizontalErrorMeters} m radius of the start position. Reduce the root motion.`, {
            where: model.mainFile,
            measured: round3(horizontal),
            limit: rm.horizontalErrorMeters
          })
        );
      }
      if (vertical > rm.verticalErrorMeters) {
        findings.push(
          emoteFinding("root-motion", "E-05", "error", `The hips travel ${round3(vertical)} m vertically — the hard limit is ${rm.verticalErrorMeters} m. Reduce the vertical motion.`, {
            where: model.mainFile,
            measured: round3(vertical),
            limit: rm.verticalErrorMeters
          })
        );
      } else if (vertical > rm.verticalWarnMeters) {
        findings.push(
          emoteFinding("root-motion", "E-05", "warning", `The hips travel ${round3(vertical)} m vertically — more than ${rm.verticalWarnMeters} m often reads as the avatar leaving the ground. Double-check the motion is intentional.`, {
            where: model.mainFile,
            measured: round3(vertical),
            limit: rm.verticalWarnMeters
          })
        );
      }
    }
    return findings;
  }
};

const clipNames: CheckDefinition = {
  name: "clip-names",
  group: "emote",
  rule: "E-06",
  title: "Clip names",
  describe: "clip names start with a capital, use only letters/digits/underscores, and capitalize each word",
  appliesTo: emoteOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      for (const anim of model.doc.getRoot().listAnimations()) {
        const name = anim.getName();
        const where = `${model.mainFile} › ${name}`;
        if (!/^[A-Z]/.test(name)) {
          findings.push(
            emoteFinding("clip-names", "E-06", "error", `Clip name "${name}" must start with a capital letter (e.g. "Wave_Avatar"). Rename the clip.`, { where, data: { clip: name } })
          );
        }
        const invalid = [...new Set(name.match(/[^A-Za-z0-9_]/g) ?? [])];
        if (invalid.length > 0) {
          findings.push(
            emoteFinding("clip-names", "E-06", "error", `Clip name "${name}" contains ${invalid.map((c) => JSON.stringify(c)).join(", ")} — use only letters, digits and underscores (no spaces or special characters).`, {
              where,
              data: { clip: name, characters: invalid }
            })
          );
        } else {
          const lowerWords = name.split("_").slice(1).filter((w) => /^[a-z]/.test(w));
          if (lowerWords.length > 0) {
            findings.push(
              emoteFinding("clip-names", "E-06", "warning", `Each word in a clip name should start with a capital letter — lowercase after "_": ${lowerWords.join(", ")} (e.g. "Wave_Avatar", not "Wave_avatar").`, {
                where,
                data: { clip: name, words: lowerWords }
              })
            );
          }
        }
      }
    }
    return findings;
  }
};

const props: CheckDefinition = {
  name: "props",
  group: "emote",
  rule: "E-07",
  title: "Props",
  describe: "prop stays within the triangle, material, texture and bone budgets",
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
      let triangles = 0;
      const materials = new Set<Material>();
      const textures = new Set<Texture>();
      for (const node of nodes) {
        const mesh = node.getMesh();
        if (!mesh || isColliderNode(node)) continue;
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
          emoteFinding("props", "E-07", "error", `The prop uses ${triangles} triangles — props are limited to ${propMaxTriangles}. Decimate the prop mesh.`, {
            where,
            measured: triangles,
            limit: propMaxTriangles,
            data: { metric: "triangles" }
          })
        );
      }
      if (materials.size > propMaxMaterials) {
        findings.push(
          emoteFinding("props", "E-07", "error", `The prop uses ${materials.size} materials — props are limited to ${propMaxMaterials}. Merge the prop's materials.`, {
            where,
            measured: materials.size,
            limit: propMaxMaterials,
            data: { metric: "materials" }
          })
        );
      }
      if (textures.size > propMaxTextures) {
        findings.push(
          emoteFinding("props", "E-07", "error", `The prop uses ${textures.size} textures — props are limited to ${propMaxTextures}. Combine the prop's textures into an atlas.`, {
            where,
            measured: textures.size,
            limit: propMaxTextures,
            data: { metric: "textures" }
          })
        );
      }
      if (joints.size > propMaxBones) {
        findings.push(
          emoteFinding("props", "E-07", "error", `The prop armature has ${joints.size} bones — props are limited to ${propMaxBones}. Simplify the prop rig.`, {
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

function avatarClipSeconds(models: ParsedModel[]): number | undefined {
  let max: number | undefined;
  for (const model of models) {
    const anims = model.doc.getRoot().listAnimations();
    if (anims.length === 0) continue;
    const avatarClips = anims.filter((a) => a.getName().endsWith("_Avatar"));
    const used = avatarClips.length > 0 ? avatarClips : anims;
    for (const anim of used) {
      const seconds = clipDuration(anim);
      if (max === undefined || seconds > max) max = seconds;
    }
  }
  return max;
}

const audio: CheckDefinition = {
  name: "audio",
  group: "emote",
  rule: "E-08",
  title: "Audio",
  describe: "audio is .mp3/.ogg, within the size budget, and matches the animation length",
  appliesTo: emoteOnly,
  run: async (ctx) => {
    const findings: Finding[] = [];
    const { audioDurationToleranceSeconds } = ctx.manifest.emote;
    const limitBytes = ctx.manifest.fileSize.audioBytes;
    const audioFiles: { path: string; bytes: Uint8Array; ext: string }[] = [];
    for (const [path, bytes] of ctx.files) {
      const dot = path.lastIndexOf(".");
      const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
      if (AUDIO_LIKE_EXTENSIONS.includes(ext)) audioFiles.push({ path, bytes, ext });
    }
    if (audioFiles.length === 0) return findings;
    let totalBytes = 0;
    for (const file of audioFiles) {
      totalBytes += file.bytes.length;
      if (!VALID_AUDIO_EXTENSIONS.includes(file.ext)) {
        findings.push(
          emoteFinding("audio", "E-08", "error", `"${file.path}" is a ${file.ext} file — emote audio must be ${VALID_AUDIO_EXTENSIONS.join(" or ")}. Convert the file.`, {
            where: file.path,
            measured: file.ext,
            limit: VALID_AUDIO_EXTENSIONS.join("/")
          })
        );
      }
    }
    if (totalBytes > limitBytes) {
      findings.push(
        emoteFinding("audio", "E-08", "error", `Audio files total ${mb(totalBytes)} MB — the audio budget is ${mb(limitBytes)} MB. Compress or shorten the audio.`, {
          measured: totalBytes,
          limit: limitBytes,
          data: { files: audioFiles.map((f) => f.path) }
        })
      );
    }
    const clipSeconds = avatarClipSeconds(ctx.models);
    for (const file of audioFiles) {
      if (!VALID_AUDIO_EXTENSIONS.includes(file.ext)) continue;
      let seconds: number | undefined;
      try {
        seconds = (await parseBuffer(file.bytes, AUDIO_MIME[file.ext])).format.duration;
      } catch {
        seconds = undefined;
      }
      if (seconds === undefined || !Number.isFinite(seconds)) {
        findings.push(
          emoteFinding("audio", "E-08", "warning", `Couldn't read the duration of "${file.path}" — make sure it's a valid ${file.ext} file so the audio can be checked against the animation length.`, {
            where: file.path
          })
        );
      } else if (clipSeconds !== undefined && Math.abs(seconds - clipSeconds) > audioDurationToleranceSeconds) {
        findings.push(
          emoteFinding(
            "audio",
            "E-08",
            "warning",
            `"${file.path}" lasts ${round3(seconds)} s but the animation lasts ${round3(clipSeconds)} s — audio should match the clip within ${audioDurationToleranceSeconds} s so it doesn't cut off or trail behind.`,
            { where: file.path, measured: round3(seconds), limit: round3(clipSeconds) }
          )
        );
      }
    }
    return findings;
  }
};

function extractOutcomeClips(outcome: unknown): string[] {
  if (!outcome || typeof outcome !== "object") return [];
  const clips = (outcome as Record<string, unknown>).clips;
  if (Array.isArray(clips)) {
    const names: string[] = [];
    for (const clip of clips) {
      if (typeof clip === "string") names.push(clip);
      else if (clip && typeof clip === "object") {
        const name = (clip as Record<string, unknown>).clip ?? (clip as Record<string, unknown>).animation;
        if (typeof name === "string") names.push(name);
      }
    }
    return names;
  }
  if (clips && typeof clips === "object") {
    return Object.values(clips as Record<string, unknown>).filter((v): v is string => typeof v === "string");
  }
  return [];
}

const socialOutcomes: CheckDefinition = {
  name: "social-outcomes",
  group: "emote",
  rule: "E-09",
  title: "Social outcomes",
  describe: "social emote outcomes stay within the limit and reference clips that exist in the GLB",
  appliesTo: (ctx) => {
    const base = emoteOnly(ctx);
    if (base !== true) return base;
    const emoteData = ctx.item.emoteData;
    if (emoteData && (emoteData.outcomes !== undefined || emoteData.startAnimation !== undefined)) return true;
    return "not a social emote — metadata carries no outcomes or startAnimation";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const maxOutcomes = ctx.manifest.emote.maxSocialOutcomes;
    const emoteData = ctx.item.emoteData ?? {};
    const outcomes = Array.isArray(emoteData.outcomes) ? emoteData.outcomes : undefined;
    if (outcomes && outcomes.length > maxOutcomes) {
      findings.push(
        emoteFinding("social-outcomes", "E-09", "error", `The emote declares ${outcomes.length} outcomes — social emotes may have at most ${maxOutcomes}. Remove the extra outcomes.`, {
          measured: outcomes.length,
          limit: maxOutcomes
        })
      );
    }
    if (emoteData.startAnimation != null && (!outcomes || outcomes.length === 0)) {
      findings.push(
        emoteFinding("social-outcomes", "E-09", "error", "startAnimation is set but the emote has no outcomes — social emotes need both (ADR-287). Add outcomes or remove startAnimation.", {
          data: { hasOutcomes: false }
        })
      );
    }
    if (outcomes) {
      const clipNamesInGlb = new Set(ctx.models.flatMap((m) => m.doc.getRoot().listAnimations().map((a) => a.getName())));
      outcomes.forEach((outcome, index) => {
        for (const clip of extractOutcomeClips(outcome)) {
          if (!clipNamesInGlb.has(clip)) {
            findings.push(
              emoteFinding(
                "social-outcomes",
                "E-09",
                "error",
                `Outcome ${index + 1} references the clip "${clip}", which doesn't exist in the GLB (clips found: ${[...clipNamesInGlb].join(", ") || "none"}). Fix the clip name in the outcome.`,
                { where: clip, data: { outcome: index + 1 } }
              )
            );
          }
        }
      });
    }
    return findings;
  }
};

export const emoteChecks: CheckDefinition[] = [duration, animationClips, boneTargets, loopSeam, rootMotion, clipNames, props, audio, socialOutcomes];
