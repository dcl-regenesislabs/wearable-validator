/** P1 Files & metadata — rule-book order. */
import { fileFormat } from "./file-format/index.js";
import { gltfValid } from "./gltf-valid/index.js";
import { metadata } from "./metadata/index.js";
import { representations } from "./representations/index.js";
import { fileSize } from "./file-size/index.js";
import { thumbnail } from "./thumbnail/index.js";
import { nameDescription } from "./name-description/index.js";
import { category } from "./category/index.js";
import { contentIntegrity } from "./content-integrity/index.js";
import { gltfHygiene } from "./gltf-hygiene/index.js";
import { smartWearable } from "./smart-wearable/index.js";

export const filesChecks = [
  fileFormat,
  gltfValid,
  metadata,
  representations,
  fileSize,
  thumbnail,
  nameDescription,
  category,
  contentIntegrity,
  gltfHygiene,
  smartWearable
];
