import assert from "node:assert/strict";
import { it } from "node:test";
import JSZip from "jszip";
import { inputTooLarge, manifest, validate } from "@dcl-regenesislabs/wearable-validator";
import { oversizedManifestZip } from "../../wearable-validator/test/helpers/hostile-inputs.js";
import { syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { zipRuleContext } from "../src/item.js";
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

it("lets validation report a zip that will not open, and words the size limit like the loader", async () => {
  const damaged = new Uint8Array(64);
  damaged.set([0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(await zipRuleContext(damaged), {});
  const result = await validate(damaged);
  assert.match(result.findings[0]?.message ?? "", /cannot be opened/);
  assert.equal(inputTooLarge(manifest.fileSize.maxInputBytes + 1).startsWith("Input is "), true);
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
