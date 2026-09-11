import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { only } from "#test/helpers/findings.js";
import { wearableManifest } from "#test/helpers/manifest.js";

describe("representations (S-04)", () => {
  it("errors when the item declares no representation", async () => {
    const zip = await syntheticZip({ manifest: wearableManifest({}, { representations: [] }) });
    const findings = only((await validate(zip, { checks: ["representations"] })).findings, "representations");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /at least one/);
  });

  it("errors when the mainFile is missing from the item", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "missing.glb", contents: ["missing.glb"] }] })
    });
    const findings = only((await validate(zip, { checks: ["representations"] })).findings, "representations");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /missing\.glb/);
  });

  it("errors when listed contents are missing", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb", "texture.png"] }] })
    });
    const findings = only((await validate(zip, { checks: ["representations"] })).findings, "representations");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /texture\.png/);
  });

  it("passes a complete representation", async () => {
    const result = await validate(await syntheticZip(), { checks: ["representations"] });
    assert.equal(only(result.findings, "representations").length, 0);
  });
});
