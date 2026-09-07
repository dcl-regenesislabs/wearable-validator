/**
 * Where the docs link points, per check — live creator-docs pages with the
 * exact section anchor, verified against the rendered pages' heading ids
 * (tools can re-verify: every #anchor below appears as an <h2>/<h3> id).
 * When the generated per-check docs site ships, it becomes the primary target
 * and these become the outbound links on each page.
 */
const WEARABLES = "https://docs.decentraland.org/creator/wearables-and-emotes/wearables/creating-wearables";
const EMOTES = "https://docs.decentraland.org/creator/wearables-and-emotes/emotes/creating-emotes";
const PROPS = "https://docs.decentraland.org/creator/wearables-and-emotes/emotes/props-and-sounds";
const UPLOADING = "https://docs.decentraland.org/creator/wearables-and-emotes/manage-collections/uploading-wearables";
const SMART = "https://docs.decentraland.org/creator/scenes-sdk7/kinds-of-projects/smart-wearables";
const POLICY = "https://decentraland.org/content-policy/";

export const DOCS_LINKS: Record<string, string> = {
  // files
  "file-format": `${WEARABLES}#building-3d-models-for-wearables`,
  "gltf-valid": `${WEARABLES}#building-3d-models-for-wearables`,
  "metadata": `${UPLOADING}#properties`,
  "representations": `${UPLOADING}#adding-another-representation`,
  "file-size": `${WEARABLES}#building-3d-models-for-wearables`,
  "thumbnail": `${UPLOADING}#custom-thumbnails`,
  "name-description": `${UPLOADING}#description`,
  "category": `${UPLOADING}#category`,
  "content-integrity": `${UPLOADING}#uploading-your-file`,
  "gltf-hygiene": `${WEARABLES}#building-3d-models-for-wearables`,
  "smart-wearable": SMART,
  // model
  "triangle-count": `${WEARABLES}#building-3d-models-for-wearables`,
  "texture-count": `${WEARABLES}#base-materials-and-textures`,
  "texture-size": `${WEARABLES}#base-materials-and-textures`,
  "texture-format": `${WEARABLES}#base-materials-and-textures`,
  "texture-maps": `${WEARABLES}#base-materials-and-textures`,
  "material-count": `${WEARABLES}#base-materials-and-textures`,
  "material-names": `${WEARABLES}#base-materials-and-textures`,
  "bounding-box": `${WEARABLES}#building-3d-models-for-wearables`,
  "skeleton": `${WEARABLES}#skin-weighting`,
  "bone-weights": `${WEARABLES}#skin-weighting`,
  "hands-geometry": `${WEARABLES}#hands`,
  "hides-replaces": `${UPLOADING}#overrides`,
  "static-mesh": `${WEARABLES}#building-3d-models-for-wearables`,
  "spring-bones": `${UPLOADING}#spring-bones`,
  // emote
  "duration": `${EMOTES}#the-animation-length`,
  "animation-clips": `${EMOTES}#number-of-animations`,
  "bone-targets": `${EMOTES}#the-animation-specifications`,
  "loop-seam": `${EMOTES}#the-animation-specifications`,
  "root-motion": `${EMOTES}#the-animation-specifications`,
  "clip-names": `${EMOTES}#naming`,
  "props": `${PROPS}#the-basics-and-limitations`,
  "audio": `${PROPS}#format-and-limitations-for-audio-clips`,
  "social-outcomes": `${EMOTES}#number-of-animations`,
  // content
  "qr-code": POLICY,
  "ip-similarity": POLICY,
  "content-policy": POLICY
};
