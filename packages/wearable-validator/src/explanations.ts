/**
 * Plain-language explanations, one per check — written in the creator docs'
 * register: direct and factual. The docs site, the webview chips and the CLI
 * all read from here; a test asserts every registry check has one.
 */
export const explanations: Record<string, string> = {
  // files
  "file-format":
    "Wearables must be exported as a single .glb file. Eyebrows, eyes and mouth items are PNG images with a transparent background instead of a 3D model.",
  "gltf-valid":
    "The 3D file must be valid and readable. Corrupt or incomplete exports can't be loaded by the engine.",
  "metadata":
    "The item's information — name, category, rarity — must be complete and valid.",
  "representations":
    "The item must include a model for the body shapes it supports, and every listed file must be present in the upload.",
  "file-size":
    "The full item — model, thumbnail and rarity image included — must stay under 3 MB (9 MB for skins) so it loads fast in-world.",
  "thumbnail":
    "The thumbnail is the preview image shown in the marketplace and backpack: a square PNG with a transparent background.",
  "name-description":
    "Names are limited to 32 characters and descriptions to 64, and neither may contain the ':' character.",
  "category":
    "The item must declare a valid category (hat, upper body, feet…). Base body shapes can't be published as wearables.",
  "content-integrity":
    "Each uploaded file's hash must match its content, proving nothing was altered or corrupted after export.",
  "gltf-hygiene":
    "The model must not include cameras, lights or unsupported extensions — the engine ignores them, they only add weight.",
  "smart-wearable":
    "Smart wearables must include a complete scene bundle, request only allowed permissions, and keep the preview video under 250 MB.",

  // model
  "triangle-count":
    "Each category has a triangle budget (for example 1,500 for upper body, 500 for eyewear). Hiding other categories adds their budget to yours.",
  "texture-count":
    "Models may use at most 2 textures (5 for skins).",
  "texture-size":
    "Textures must be square and at most 512×512 pixels (256×256 for facial features).",
  "texture-format":
    "Textures must be standard 8-bit PNG or JPEG images.",
  "texture-maps":
    "Only base color, emission and alpha textures are supported. Normal and roughness maps are ignored by the avatar renderer.",
  "material-count":
    "Models may use at most 2 materials (5 for skins), not counting AvatarSkin_MAT.",
  "material-names":
    "The material that shows skin must be named AvatarSkin_MAT so the engine can tint it to the player's skin color.",
  "bounding-box":
    "The model must fit within the avatar's bounds: 2.42 m high, 2.42 m wide, 1.4 m deep.",
  "skeleton":
    "The model must be rigged to the standard avatar skeleton (62 named bones). Renamed, missing or leftover helper bones break the item in-world.",
  "bone-weights":
    "Each vertex may be influenced by at most 4 bones, and its weights must add up to 1. Anything else deforms badly during animation.",
  "hands-geometry":
    "Hand accessories must be skinned to the hand bones — worn items like gloves, not held items like swords.",
  "hides-replaces":
    "The hides and replaces lists must make sense — hiding or replacing your own category is redundant (the engine ignores it), and skins are expected to hide the standard set of slots.",
  "static-mesh":
    "Wearable models shouldn't contain animations or shape keys — the engine ignores them on wearables, so they only add file size.",
  "spring-bones":
    "Spring bones (bouncing hair, tails, earrings) are limited to 12 per item, with their physics values inside the allowed ranges.",

  // emote
  "duration":
    "Emotes are limited to 10 seconds (300 frames at 30 fps).",
  "animation-clips":
    "An emote has one avatar animation — plus one prop animation of the same length if it uses a prop — named with the _Avatar/_Prop convention.",
  "bone-targets":
    "Animation tracks may only target the avatar's bones (or the prop's). Tracks pointing anywhere else won't play in-world.",
  "loop-seam":
    "Looping emotes must start and end on the same pose, or the loop visibly snaps on every repeat.",
  "root-motion":
    "The animation must keep the avatar within 1 m of its starting position and near the ground.",
  "clip-names":
    "Animation names use Capitalized_Words_With_Underscores — no spaces or special characters.",
  "props":
    "Emote props are limited to 3,000 triangles, 2 materials, 2 textures and 62 bones.",
  "audio":
    "Emote audio must be .mp3 or .ogg, within the size limit, and roughly the same length as the animation.",
  "social-outcomes":
    "Social emotes may define up to 3 outcomes, each pointing to an animation that exists in the file.",

  // content
  "qr-code":
    "Scannable QR codes are rejected — their target can change after review."
};
