import assert from "node:assert/strict";
import { it } from "node:test";
import JSZip from "jszip";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { oversizedManifestZip } from "../../wearable-validator/test/helpers/hostile-inputs.js";
import { syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { zipRuleContext } from "../src/app.js";
import { buildItemWithBlobs } from "../src/preview.js";

it("rejects oversized ZIP manifests before extracting display metadata", async () => {
  const bytes = await oversizedManifestZip(manifest.fileSize.maxEntryUncompressedBytes + 1);
  await assert.rejects(zipRuleContext(bytes), /unpacks to .* MB/);
});

it("rejects oversized ZIP manifests before extracting preview blobs", async () => {
  const bytes = await oversizedManifestZip(manifest.fileSize.maxEntryUncompressedBytes + 1);
  await assert.rejects(buildItemWithBlobs({ name: "hostile.zip", bytes, isBareGlb: false }, "wearable"), /unpacks to .* MB/);
});

it("enforces the archive entry cap on both display and preview paths", async () => {
  const zip = new JSZip();
  for (let i = 0; i <= manifest.fileSize.maxEntries; i++) zip.file(`${i}.txt`, "x");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  await assert.rejects(zipRuleContext(bytes), /entries — the maximum is/);
  await assert.rejects(buildItemWithBlobs({ name: "hostile.zip", bytes, isBareGlb: false }, "wearable"), /entries — the maximum is/);
});

it("keeps normal ZIP metadata and reuses extracted files for preview", async () => {
  const bytes = await syntheticZip();
  const context = await zipRuleContext(bytes);
  assert.equal(context.zipCategory, "hat");
  assert.equal(context.zipMetadataSource, "wearable.json");
  assert.ok(context.zipFiles?.has("model.glb"));
  const reused = await buildItemWithBlobs({ name: "item.zip", bytes: new Uint8Array(), isBareGlb: false, ...context }, "wearable");
  const extracted = await buildItemWithBlobs({ name: "item.zip", bytes, isBareGlb: false }, "wearable");
  assert.deepEqual(reused, extracted);
});
