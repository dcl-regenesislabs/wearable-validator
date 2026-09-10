/**
 * Concrete "how to fix" guidance per check — actionable steps in the tools
 * creators actually use (Blender, the Builder, image editors). Shown next to
 * failed checks in the webview/CLI; completeness is test-enforced.
 */
export const fixes: Record<string, string> = {
  // files
  "file-format":
    "In Blender: File → Export → glTF 2.0, format 'glTF Binary (.glb)'. For eyebrows/eyes/mouth, export a square PNG with a transparent background instead.",
  "gltf-valid":
    "Re-export the model from Blender — the file is corrupt or was cut off mid-export. If it keeps failing, re-import the .glb into a fresh Blender scene to find what breaks.",
  "metadata":
    "Correct each reported field in the item metadata supplied by Builder or the server. Use the reported path, current value, and requirement; supply all required item fields and one translation per locale. For Builder ZIPs, fill in name/category and correct any supplied rarity, or re-export the item.",
  "representations":
    "Use the canonical BaseMale/BaseFemale URNs and make sure every body shape you support has its model file inside the package, and that every file listed in the manifest actually exists — re-export the item from the Builder.",
  "file-size":
    "Shrink textures first (biggest win): resize to 512×512 and re-bake. Then remove unused geometry and merge duplicated meshes. The thumbnail and rarity image count toward the limit too.",
  "thumbnail":
    "Export a 256×256 PNG with a transparent background (in Blender: render with Film → Transparent; in Photoshop/GIMP: delete the background layer before saving).",
  "name-description":
    "Shorten the name (max 32 chars) or description (max 64) and remove any ':' characters.",
  "category":
    "Pick a valid wearable slot (hat, upper body, feet…) or emote category (dance, fun, greetings…) in the Builder. Base body shapes can't be published.",
  "content-integrity":
    "Re-upload the item — a file changed after its hash was computed. Never edit files inside the package after exporting.",
  "gltf-hygiene":
    "Delete cameras and lights from the scene before exporting (or untick 'Cameras' and 'Punctual Lights' in Blender's glTF export panel). Disable unsupported material extensions.",
  "smart-wearable":
    "Include the complete scene bundle (scene.json + code), request only allowed permissions, and keep the preview video under 250 MB.",

  // model
  "triangle-count":
    "Reduce geometry in Blender: add a Decimate modifier, delete faces that are never visible (inside the body), and merge tiny details into textures. Hiding other slots adds their budget to yours.",
  "texture-count":
    "Bake your textures into a single atlas (Blender: UV → Pack Islands, then bake all materials to one image) so the model references at most 2 images.",
  "texture-size":
    "Resize the texture to 512×512 or smaller (256×256 for facial features) and make it square — re-bake or scale it in any image editor.",
  "texture-format":
    "Convert the texture to 8-bit PNG or JPEG. In Blender's image settings pick 'RGBA 8-bit'; 16-bit and exotic formats aren't supported.",
  "texture-maps":
    "Remove normal, roughness, metallic and occlusion maps — the avatar renderer ignores them. Bake any detail you want to keep into the base color texture.",
  "material-count":
    "Merge materials: join meshes and assign one shared material with an atlas texture. At most 2 materials (5 for skins), not counting AvatarSkin_MAT.",
  "material-names":
    "Rename the material that shows skin to exactly 'AvatarSkin_MAT' so the engine can tint it. Avoid reserved mesh-name patterns (_mouth, _eyebrows, _eyes) on non-facial items.",
  "bounding-box":
    "Scale the model down to fit the avatar bounds (2.42 × 2.42 × 1.4 m) and apply the scale (Ctrl+A in Blender). Check your export units are meters.",
  "skeleton":
    "Rig on the official skeleton: import Avatar_File.blend from the Blender toolkit and skin to those bones without renaming them. Delete leftover '_end' helper bones before export.",
  "bone-weights":
    "In Blender Weight Paint: Weights → Limit Total (4), then Weights → Normalize All. Re-check any vertex the finding names.",
  "hands-geometry":
    "Skin the accessory to the hand bones (Avatar_RightHand / fingers) so it moves with the hand — held props like swords aren't wearables.",
  "hides-replaces":
    "Remove the item's own category from hides/replaces (the engine ignores it anyway), and double-check the hidden slots make sense for the design.",
  "static-mesh":
    "Delete leftover animations and shape keys before exporting a wearable (in Blender: remove actions in the Dope Sheet and shape keys in Object Data) — they're ignored in-world and only add file size.",
  "spring-bones":
    "Keep at most 12 spring bones (names containing 'springbone') and keep stiffness/gravity/drag inside the allowed ranges.",

  // emote
  "duration":
    "Trim the animation to 10 seconds — 300 frames at 30 fps. Set the scene to 30 fps and cut keys past frame 300.",
  "animation-clips":
    "Keep exactly one avatar action (plus one prop action of the same length if the emote has a prop) and name them Name_Avatar / Name_Prop.",
  "bone-targets":
    "Remove animation tracks that target meshes or non-avatar objects — only the avatar's rig bones (and the prop armature) can be animated.",
  "loop-seam":
    "Copy the first frame's pose and paste it on the last frame so the loop closes cleanly (Blender: select all bones, Copy Pose on frame 1, Paste on the last frame).",
  "root-motion":
    "Keep the hips within 1 m of the starting position and near the ground — remove keys that walk the avatar away.",
  "clip-names":
    "Rename the action to Capitalized_Words_With_Underscores — no spaces or special characters (e.g. 'Party_Dance_Avatar').",
  "props":
    "Reduce the prop to 3,000 triangles, 2 materials and 2 textures, and parent it to an armature named 'Armature_Prop'.",
  "audio":
    "Convert the sound to .mp3 or .ogg, trim it to the animation's length, and keep total audio under the size limit.",
  "social-outcomes":
    "Define at most 3 outcomes and make each one point to an animation clip that exists in the GLB.",

  // content
  "qr-code":
    "Remove the QR code from the texture or thumbnail — QR targets can change after review, so they're rejected outright."
};
