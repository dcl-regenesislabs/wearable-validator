/**
 * Where "how to fix" points, per check — live creator-docs pages, verified to
 * resolve. When the generated per-check docs site ships (GitHub Pages), it
 * becomes the primary target and these become the outbound links on each page.
 */
const WEARABLES = "https://docs.decentraland.org/creator/wearables-and-emotes/wearables/creating-wearables";
const EMOTES = "https://docs.decentraland.org/creator/wearables-and-emotes/emotes/creating-emotes";
const PROPS = "https://docs.decentraland.org/creator/wearables-and-emotes/emotes/props-and-sounds";
const UPLOADING = "https://docs.decentraland.org/creator/wearables-and-emotes/manage-collections/uploading-wearables";
const SMART = "https://docs.decentraland.org/creator/scenes-sdk7/kinds-of-projects/smart-wearables";
const POLICY = "https://decentraland.org/content-policy/";

export const DOCS_LINKS: Record<string, string> = {
  // files
  "file-format": WEARABLES,
  "gltf-valid": WEARABLES,
  "metadata": UPLOADING,
  "representations": WEARABLES,
  "file-size": WEARABLES,
  "thumbnail": UPLOADING,
  "name-description": UPLOADING,
  "category": WEARABLES,
  "content-integrity": UPLOADING,
  "gltf-hygiene": WEARABLES,
  "smart-wearable": SMART,
  // model
  "triangle-count": WEARABLES,
  "texture-count": WEARABLES,
  "texture-size": WEARABLES,
  "texture-format": WEARABLES,
  "texture-maps": WEARABLES,
  "material-count": WEARABLES,
  "material-names": WEARABLES,
  "bounding-box": WEARABLES,
  "skeleton": WEARABLES,
  "bone-weights": WEARABLES,
  "hands-geometry": WEARABLES,
  "hides-replaces": WEARABLES,
  "static-mesh": WEARABLES,
  "spring-bones": WEARABLES,
  // emote
  "duration": EMOTES,
  "animation-clips": EMOTES,
  "bone-targets": EMOTES,
  "loop-seam": EMOTES,
  "root-motion": EMOTES,
  "clip-names": EMOTES,
  "props": PROPS,
  "audio": PROPS,
  "social-outcomes": EMOTES,
  // content
  "qr-code": POLICY,
  "ip-similarity": POLICY,
  "content-policy": POLICY
};
