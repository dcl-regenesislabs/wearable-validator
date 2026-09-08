/**
 * "How the validator checks it" — one paragraph per check describing what the
 * implementation actually measures (the same detail level as the RFC's rule
 * toggles). Shown in the webview's expanded panels and the generated docs.
 */
export const details: Record<string, string> = {
  // files
  "file-format":
    "Reads the model files' magic bytes — a real GLB starts with the 'glTF' header. Facial-feature categories route to the PNG path instead (square, ≤256×256, alpha channel) and skip every mesh rule.",
  "gltf-valid":
    "Verifies the GLB container byte by byte — magic, version 2, declared length, chunk layout — and surfaces model-parser failures as findings.",
  "metadata":
    "Checks required fields per mode: full entity metadata when the platform supplies it, or the lighter set a Builder zip can carry. A divergence between supplied metadata and the zip's own manifest is flagged.",
  "representations":
    "Set-compares both directions: every file a representation lists must exist in the upload, and its mainFile must be among them. At least one body-shape representation is required.",
  "file-size":
    "Sums the actual file bytes — model, thumbnail and rarity image included (ADR-246) — against the per-category ceiling, plus the model-alone headroom rule so nothing passes here and fails at deploy.",
  "thumbnail":
    "Decodes the PNG: format, ≤1 MB and ≤1024×1024 are hard limits; squareness, the 256×256 recommendation and background transparency (alpha scan) are warnings.",
  "name-description":
    "Plain string checks: name ≤32 characters, description ≤64, no ':' anywhere, at most 20 non-empty tags.",
  "category":
    "The declared category must be one of the platform's wearable slots; base body shapes are rejected.",
  "content-integrity":
    "Recomputes each file's CIDv1 hash and compares it against the declared content list, both directions. Runs only when an entity content list is available (platform submissions and published items).",
  "gltf-hygiene":
    "Reads the raw glTF JSON — even when the model won't parse: cameras and lights are errors; required extensions outside the supported allowlist are errors; unknown used extensions warn.",
  "smart-wearable":
    "Checks the scene bundle is complete, requested permissions are in the allowed set, video files stay under the cap (by size — never decoded), and reports stray zero-byte files.",

  // model
  "triangle-count":
    "Counts triangles per representation from the mesh data (indices ÷ 3; collider nodes excluded) and compares against the effective budget: the category's base plus every hidden slot's budget.",
  "texture-count":
    "Counts unique texture images referenced by any material slot, with AvatarSkin_MAT excluded from the count.",
  "texture-size":
    "Reads each image's dimensions from its header: over the limit or non-square fails; non-power-of-two dimensions warn.",
  "texture-format":
    "Sniffs the image magic bytes (PNG/JPEG only) and reads the bit depth from the header — 8-bit required.",
  "texture-maps":
    "Walks every material: normal, metallic-roughness and occlusion maps are errors that name the offending map.",
  "material-count":
    "Counts the materials used by rendered meshes, excluding the one named AvatarSkin_MAT.",
  "material-names":
    "Skin items should carry an AvatarSkin_MAT material (the engine's tint target); non-facial mesh names must avoid the reserved facial patterns.",
  "bounding-box":
    "Computes the rest-pose world-space bounding box from node-transformed vertex positions (colliders excluded), rounded to 2 decimals, against 2.42 × 2.42 × 1.4 m.",
  "skeleton":
    "Compares every skin joint against the canonical 62-bone skeleton: unknown non-springbone joints (with a casing hint when it's just casing), leftover _end/_neutral helpers, and missing core bones on skinned meshes all fail.",
  "bone-weights":
    "Reads the skinning data directly: per-vertex weights must sum to 1 (±0.02) with at most 4 effective influences — a second joint set with non-zero weights counts. Zero-weight vertices warn.",
  "hands-geometry":
    "hands_wear items must contain a skinned mesh with at least half its weight on the hand bones — otherwise it looks like a held prop and warns (the final judgment is visual).",
  "hides-replaces":
    "Checks the hides/replaces lists: hiding your own category fails; skins are expected to hide the standard slot set (a warning when incomplete).",
  "static-mesh":
    "Wearable GLBs must carry no animation clips and no morph targets — both are errors.",
  "spring-bones":
    "Counts springbone-named joints (warns above 12) and, when spring-bone metadata is present, validates every physics value against its allowed range.",

  // emote
  "duration":
    "Takes the longest keyframe time across every channel of every clip — over 10 s fails. A frame rate inferred far from 30 fps warns.",
  "animation-clips":
    "Counts the clips: more than the allowed set fails; a two-clip emote must be the _Avatar/_Prop pair with matching lengths (within one frame).",
  "bone-targets":
    "Every animation channel must target a canonical avatar bone, a spring bone, or the prop armature — mesh nodes and unknown names fail.",
  "loop-seam":
    "For looping emotes, compares the first and last keyframe of every channel (position, rotation and scale epsilons) and lists the bones that would visibly snap.",
  "root-motion":
    "Follows the hips translation channel through the rig's rest transforms: over 1 m horizontal fails; over 1 m vertical warns; over 4 m fails.",
  "clip-names":
    "Checks the action names: capital first letter, underscores only; per-word capitalization is a warning.",
  "props":
    "Measures the prop armature's subtree — triangles, materials, textures and bone count — against the prop budgets.",
  "audio":
    "Validates the audio extension (.mp3/.ogg) and total size, and parses the real audio duration to compare against the clip (±0.5 s warns).",
  "social-outcomes":
    "When outcomes metadata exists: at most 3, each referencing an animation clip that actually exists in the GLB.",

  // content
  "qr-code":
    "Decodes every texture and the thumbnail to pixels and runs a QR detector over them — any readable code fails."
};
