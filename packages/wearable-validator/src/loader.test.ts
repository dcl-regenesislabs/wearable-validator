import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { manifest } from "./manifest/index.js";
import { declaredEntryCount, inflateEntry, loadInput } from "./loader.js";
import { syntheticZip } from "#test/helpers/synthetic.js";

const { maxEntries, maxUncompressedBytes, maxEntryUncompressedBytes } = manifest.fileSize;

/** Rewrites the uncompressed size every local and central header declares for the zip's only entry — a lying header. */
function declareUncompressedSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b) continue;
    if (out[i + 2] === 0x03 && out[i + 3] === 0x04) view.setUint32(i + 22, size, true);
    if (out[i + 2] === 0x01 && out[i + 3] === 0x02) view.setUint32(i + 24, size, true);
  }
  return out;
}

async function singleEntryZip(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("model.glb", bytes, { compression: "DEFLATE" });
  return zip.generateAsync({ type: "uint8array" });
}

describe("loadInput zip bounds", () => {
  it("refuses a zip whose headers declare more bytes than the cap before inflating anything", async () => {
    const zip = declareUncompressedSize(await singleEntryZip(new Uint8Array(64)), maxEntryUncompressedBytes + 1);
    await assert.rejects(loadInput(zip, {}), /unpacks to .* MB — no file in the zip may unpack to more than/);
    assert.ok(maxEntryUncompressedBytes <= maxUncompressedBytes);
  });

  it("refuses a zip with more entries than the cap", async () => {
    const zip = new JSZip();
    for (let i = 0; i < maxEntries + 44; i++) zip.file(`part-${i}.bin`, new Uint8Array([i & 0xff]));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await assert.rejects(loadInput(bytes, {}), new RegExp(`holds ${maxEntries + 44} entries — the maximum is ${maxEntries}`));
  });

  it("counts folders as entries too", async () => {
    const zip = new JSZip();
    zip.file("model.glb", new Uint8Array(4));
    for (let i = 0; i < maxEntries; i++) zip.folder(`folder-${i}`);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    assert.equal(declaredEntryCount(bytes), maxEntries + 1);
    await assert.rejects(loadInput(bytes, {}), /entries — the maximum is/);
  });

  it("refuses from the end-of-central-directory record before parsing anything, zip64 included", async () => {
    const declared = 300_000;
    // local header of one empty entry, then a zip64 EOCD record, its locator and an EOCD whose count overflows to 0xffff
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    const zip64 = new Uint8Array(56);
    const zip64View = new DataView(zip64.buffer);
    zip64View.setUint32(0, 0x06064b50, true);
    zip64View.setBigUint64(24, BigInt(declared), true);
    zip64View.setBigUint64(32, BigInt(declared), true);
    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, 0x07064b50, true);
    locatorView.setBigUint64(8, BigInt(local.length), true);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, 0xffff, true);
    eocdView.setUint16(10, 0xffff, true);
    const bytes = new Uint8Array([...local, ...zip64, ...locator, ...eocd]);
    assert.equal(declaredEntryCount(bytes), declared);
    await assert.rejects(loadInput(bytes, {}), new RegExp(`holds ${declared} entries`));
    assert.equal(declaredEntryCount(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), undefined);
  });

  it("stops inflating an entry the moment the real bytes pass the budget, whatever the header said", async () => {
    const zip = await JSZip.loadAsync(await singleEntryZip(new Uint8Array(1_048_576)));
    const entry = zip.file("model.glb");
    assert.ok(entry);
    await assert.rejects(inflateEntry(entry, 4096, "past the budget"), /past the budget/);
    assert.equal((await inflateEntry(entry, 1_048_576, "past the budget")).length, 1_048_576);
  });

  it("still loads a normal builder zip", async () => {
    const loaded = await loadInput(await syntheticZip(), {});
    assert.equal(loaded.fatal, undefined);
    assert.ok(loaded.ctx?.files.has("model.glb"));
    assert.equal(loaded.ctx?.inputKind, "zip");
  });
});
