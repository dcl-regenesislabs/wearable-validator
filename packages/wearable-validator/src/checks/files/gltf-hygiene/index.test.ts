import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { only } from "#test/helpers/findings.js";
import { patchGlbJson } from "#test/helpers/glb-json.js";

describe("gltf-hygiene (S-10)", () => {
  it("errors on cameras", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.cameras = [{ type: "perspective", perspective: { yfov: 1, znear: 0.1 } }];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /camera/);
  });

  it("errors on lights (KHR_lights_punctual)", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.extensionsUsed = ["KHR_lights_punctual"];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /lights/);
  });

  it("errors on required extensions outside the allowlist", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.extensionsUsed = ["EXT_not_supported_anywhere"];
      j.extensionsRequired = ["EXT_not_supported_anywhere"];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].data?.extension, "EXT_not_supported_anywhere");
  });

  it("warns on unknown used-but-not-required extensions", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.extensionsUsed = ["EXT_totally_custom"];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.extension, "EXT_totally_custom");
  });

  it("warns on a ±90°-X root rotation only when the heuristic is enabled (off by default)", async () => {
    const glb = await syntheticGlb({ rootRotation: [0.70710678, 0, 0, 0.70710678] });
    const zip = await syntheticZip({ glb });
    // Off by default — fired on virtually every committee-approved catalyst item.
    assert.equal(only((await validate(zip, { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene").length, 0);
    const gltfConfig = manifest.gltf as { zUpHeuristic?: boolean };
    gltfConfig.zUpHeuristic = true;
    try {
      const findings = only((await validate(zip, { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
      assert.equal(findings.length, 1);
      assert.equal(findings[0].severity, "warning");
      assert.match(findings[0].message, /Z-up/);
    } finally {
      gltfConfig.zUpHeuristic = false;
    }
  });

  it("passes a clean allowlisted GLB", async () => {
    const result = await validate(await syntheticZip(), { checks: ["gltf-hygiene"] });
    assert.equal(only(result.findings, "gltf-hygiene").length, 0);
  });
});
