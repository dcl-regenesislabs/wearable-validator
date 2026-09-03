/**
 * Plain-language explanations, one per check — written for creators and
 * non-technical users. The docs site, the webview chips and the CLI all
 * read from here; a test asserts every registry check has one.
 */
export const explanations: Record<string, string> = {
  // files
  "file-format":
    "Your item has to arrive in the right kind of files. 3D models must be .glb files (one self-contained 3D file); eyebrows, eyes and mouth items are PNG images with a see-through background.",
  "gltf-valid":
    "Checks the 3D file isn't broken — like checking a zip isn't corrupted. If the file is damaged or half-exported, nothing else can read it.",
  "metadata":
    "Every item comes with a little ID card: its name, category, rarity and so on. This checks the card is filled in correctly.",
  "representations":
    "Avatars come in two body shapes. This checks your item says which shapes it supports, and that the model file for each shape is actually inside the package.",
  "file-size":
    "The whole item must stay under a size limit (3 MB, 9 MB for skins) so it downloads fast for everyone. The preview picture counts toward it too.",
  "thumbnail":
    "The little preview picture shown in the marketplace and the backpack. It must be a square PNG with a see-through background.",
  "name-description":
    "The name and description have length limits and can't contain the ':' character, because it breaks the systems that read them.",
  "category":
    "Every wearable needs a valid slot — hat, upper body, shoes… This checks the slot exists and is one you're allowed to publish.",
  "content-integrity":
    "Every file comes with a fingerprint. This re-computes all the fingerprints and checks they match — proof nothing was swapped or corrupted on the way.",
  "gltf-hygiene":
    "3D files can carry extra baggage: cameras, lights, exotic features other tools added. Avatars don't use any of that, so it has to come out.",
  "smart-wearable":
    "Smart wearables carry a mini-program. This checks the program's files are all there, that it only asks for allowed permissions, and that its video isn't oversized.",

  // model
  "triangle-count":
    "3D models are built from tiny triangles — more triangles means more work for every player's computer. Each clothing slot has a triangle budget; hiding other slots lets you borrow their budget.",
  "texture-count":
    "Textures are the images painted onto the model. Only 2 are allowed (5 for skins) so items stay light.",
  "texture-size":
    "Each texture image has a maximum resolution and must be square. Bigger images look barely better on an avatar but cost everyone memory.",
  "texture-format":
    "Texture images must be ordinary PNG or JPEG, 8-bit — the formats every device can display.",
  "texture-maps":
    "Models may only use basic color, glow and transparency images. Fancy material effects (normal or roughness maps) aren't supported by the avatar renderer, so they'd just be dead weight.",
  "material-count":
    "Materials are like different kinds of paint on the model. At most 2 (5 for skins) — every extra one slows rendering down.",
  "material-names":
    "A few names are special: the material for visible skin must be called AvatarSkin_MAT so the game can tint it to each player's skin color.",
  "bounding-box":
    "The item must fit inside an invisible box around the avatar (about 2.4 m tall and wide). Any bigger and it pokes into the world around you.",
  "skeleton":
    "Avatars move using a standard skeleton of 62 named bones. Your model must attach to exactly those bones — renamed or extra bones make the item deform weirdly or break.",
  "bone-weights":
    "Every point of the model follows at most 4 bones, and its 'how much do I follow each bone' numbers must add up to 100%. Otherwise the mesh stretches strangely when the avatar moves.",
  "hands-geometry":
    "Hand accessories are worn ON the hand — gloves, rings — attached to the hand bones. They can't be held objects like swords or shields.",
  "hides-replaces":
    "A wearable can hide other slots (a helmet hides hair). This checks the hide list makes sense — for example, an item can't hide its own slot.",
  "static-mesh":
    "Wearables must hold still — movement belongs to emotes. This checks no animations or shape-changing tricks were left inside the file.",
  "spring-bones":
    "Spring bones make parts bounce and sway — tails, earrings, ponytails. At most 12, with movement settings inside allowed ranges so nothing flails wildly.",

  // emote
  "duration":
    "Emotes can last at most 10 seconds.",
  "animation-clips":
    "An emote is one animation (plus one more for its prop, if it has one), named the standard way so the game knows which is which.",
  "bone-targets":
    "The animation may only move the avatar's real bones (or its prop). Moving anything else does nothing in-game — or breaks the emote.",
  "loop-seam":
    "Looping emotes should end in the same pose they started in — otherwise the avatar visibly snaps every time the loop restarts.",
  "root-motion":
    "The avatar can't wander off: an emote may move it about 1 meter sideways at most, and must keep it near the ground.",
  "clip-names":
    "Animation names follow a simple convention (Capital_Letters_With_Underscores) so tools can read them reliably.",
  "props":
    "If the emote uses an object — a guitar, a balloon — the object has its own small budgets: triangles, materials, textures and bones.",
  "audio":
    "Emote sound must be an .mp3 or .ogg file, small enough, and roughly as long as the animation itself.",
  "social-outcomes":
    "Some emotes are for two players (a high five!). This checks the possible outcomes are set up right — at most 3, each pointing at a real animation.",

  // content
  "qr-code":
    "No scannable QR codes hidden in textures or the thumbnail — they can smuggle links to scams past review."
};
