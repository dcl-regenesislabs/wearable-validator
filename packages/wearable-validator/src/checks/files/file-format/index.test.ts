import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { pngBytes, pngHeaderBytes, syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";
import { wearableManifest } from "#test/helpers/manifest.js";

describe("file-format (S-01)", () => {
  it("errors on a .gltf model file", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.gltf", contents: ["model.gltf"] }] }),
      extraFiles: { "model.gltf": enc("{}") }
    });
    const findings = only((await validate(zip, { checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "model.gltf");
    assert.match(findings[0].message, /\.glb/);
  });

  it("errors on a .glb whose content is not GLB binary", async () => {
    const zip = await syntheticZip({ glb: enc("not a real model at all, sorry!!") });
    const findings = only((await validate(zip, { checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not GLB binary/);
  });

  it("errors on oversize facial-feature PNGs", async () => {
    const findings = only((await validate(pngBytes(300, 300), { category: "eyes", checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, "256×256");
  });

  it("errors from the header alone on a facial-feature PNG claiming bomb-sized dimensions", async () => {
    const findings = only((await validate(pngHeaderBytes(12000, 12000), { category: "eyes", checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "12000×12000");
    assert.equal(findings[0].limit, "256×256");
  });

  it("passes a valid facial-feature PNG and a valid wearable zip", async () => {
    const facial = await validate(pngBytes(256, 256), { category: "mouth", checks: ["file-format"] });
    assert.equal(only(facial.findings, "file-format").length, 0);
    const zip = await validate(await syntheticZip(), { checks: ["file-format"] });
    assert.equal(only(zip.findings, "file-format").length, 0);
  });
});
