import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { pngBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";
import { wearableManifest } from "#test/helpers/manifest.js";

describe("metadata (S-03)", () => {
  it("errors when no metadata is provided at all", async () => {
    const files = new Map<string, Uint8Array>([["model.glb", await syntheticGlb()]]);
    const findings = only((await validate({ files }, { checks: ["metadata"] })).findings, "metadata");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /No metadata/);
  });

  it("errors on an unparseable embedded manifest", async () => {
    const zip = await syntheticZip({ manifestRaw: "{not json" });
    const findings = only((await validate(zip, { checks: ["metadata"] })).findings, "metadata");
    assert.ok(findings.length >= 1);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => /not valid JSON/.test(f.message)));
  });

  it("warns when explicit metadata diverges from the embedded manifest", async () => {
    const files = new Map<string, Uint8Array>([
      ["model.glb", await syntheticGlb()],
      ["wearable.json", enc(JSON.stringify(wearableManifest({ name: "Zip Name" })))],
      ["thumbnail.png", pngBytes(256, 256)]
    ]);
    const metadata = {
      name: "Entity Name",
      description: "synthetic",
      rarity: "common",
      thumbnail: "thumbnail.png",
      data: { category: "hat", representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"] }] }
    };
    const findings = only((await validate({ files, metadata }, { checks: ["metadata"] })).findings, "metadata");
    const warnings = findings.filter(f => f.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].data?.fields, ["name"]);
    assert.match(warnings[0].message, /embedded manifest/);
    assert.ok(findings.some(f => f.severity === "error" && f.where === "id"));
  });

  it("passes a builder zip with name and category", async () => {
    const result = await validate(await syntheticZip(), { checks: ["metadata"] });
    assert.equal(only(result.findings, "metadata").length, 0);
  });
});
