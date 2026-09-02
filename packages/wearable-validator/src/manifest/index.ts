import manifestJson from "./manifest.json" with { type: "json" };

export interface Manifest {
  version: string;
  triangles: { default: number; perCategory: Record<string, number>; handsWearHiddenHandsLimit: number };
  textures: { default: number; skin: number; maxSize: number; facialMaxSize: number };
  materials: { default: number; skin: number; avatarSkinMat: string; forbiddenMeshNamePatterns: string[] };
  facialCategories: string[];
  fileSize: {
    wearableBytes: number; skinBytes: number; emoteBytes: number; modelHeadroomBytes: number;
    thumbnailBytes: number; thumbnailMaxSize: number; thumbnailRecommendedSize: number;
    smartWearableVideoBytes: number; audioBytes: number; maxInputBytes: number;
  };
  boundingBox: { width: number; height: number; depth: number };
  /** ADR-60 auto-hide set — the categories a skin is expected to hide. */
  skinAutoHideSet: string[];
  text: { nameMax: number; descriptionMax: number; forbiddenChars: string[]; tagsMax: number };
  skeleton: {
    armatureName: string; propArmatureName: string; maxInfluences: number; weightSumEpsilon: number;
    springBoneToken: string; maxSpringBones: number;
    springBone: { stiffness: [number, number]; gravityPower: [number, number]; drag: [number, number]; gravityDir: [number, number] };
  };
  emote: {
    maxDurationSeconds: number; expectedFps: number; fpsTolerance: number; maxFrames: number;
    maxClipsBasic: number; maxClipsWithProps: number;
    propMaxTriangles: number; propMaxMaterials: number; propMaxTextures: number; propMaxBones: number;
    propClipLengthToleranceSeconds: number; audioDurationToleranceSeconds: number;
    rootMotion: { horizontalErrorMeters: number; verticalWarnMeters: number; verticalErrorMeters: number; hipsPattern: string };
    maxSocialOutcomes: number;
  };
  epsilons: { loopSeamTranslation: number; loopSeamQuaternionDot: number; loopSeamScale: number; zUpRotationToleranceDegrees: number };
  gltf: { extensionAllowlist: string[]; unknownCodeSeverity: string; severityOverrides: Record<string, string> };
  hands: { minHandWeightRatio: number };
  thumbnail: { minTransparentPixelRatio: number; alphaThreshold: number };
  receipts: Record<string, string>;
}

export const manifest = manifestJson as unknown as Manifest;

const HAND_FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
function handFingerBones(side: "Left" | "Right"): string[] {
  return HAND_FINGERS.flatMap((finger) => [1, 2, 3, 4].map((segment) => `Avatar_${side}Hand${finger}${segment}`));
}

/** Canonical Decentraland avatar skeleton (62 deform bones). */
export const AVATAR_BONE_NAMES: string[] = [
  "Avatar_Hips", "Avatar_Spine", "Avatar_Spine1", "Avatar_Spine2", "Avatar_Neck", "Avatar_Head",
  "Avatar_LeftShoulder", "Avatar_LeftArm", "Avatar_LeftForeArm", "Avatar_LeftHand",
  ...handFingerBones("Left"),
  "Avatar_RightShoulder", "Avatar_RightArm", "Avatar_RightForeArm", "Avatar_RightHand",
  ...handFingerBones("Right"),
  "Avatar_LeftUpLeg", "Avatar_LeftLeg", "Avatar_LeftFoot", "Avatar_LeftToeBase",
  "Avatar_RightUpLeg", "Avatar_RightLeg", "Avatar_RightFoot", "Avatar_RightToeBase"
];
export const AVATAR_BONE_NAME_SET = new Set(AVATAR_BONE_NAMES);

/** Minimal required subset — a skeleton missing these is non-DCL, independent of optional fingers/toes. */
export const AVATAR_CORE_BONE_NAMES: string[] = [
  "Avatar_Hips", "Avatar_Spine", "Avatar_Neck", "Avatar_Head",
  "Avatar_LeftArm", "Avatar_LeftForeArm", "Avatar_LeftHand",
  "Avatar_RightArm", "Avatar_RightForeArm", "Avatar_RightHand",
  "Avatar_LeftUpLeg", "Avatar_LeftLeg", "Avatar_LeftFoot",
  "Avatar_RightUpLeg", "Avatar_RightLeg", "Avatar_RightFoot"
];

/** effectiveLimit = base + Σ unique hides' budgets; hands_wear base bumps to 1,500 when hiding 'hands'. */
export function effectiveTriangleLimit(category: string, hides: string[] = []): number {
  const uniqueHides = [...new Set(hides)];
  let base = manifest.triangles.perCategory[category] ?? manifest.triangles.default;
  if (category === "hands_wear" && uniqueHides.includes("hands")) base = manifest.triangles.handsWearHiddenHandsLimit;
  let limit = base;
  for (const hidden of uniqueHides) {
    limit += manifest.triangles.perCategory[hidden] ?? 0;
  }
  return limit;
}
