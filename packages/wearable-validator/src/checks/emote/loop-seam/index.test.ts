import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { of } from "#test/helpers/emote.js";

describe("loop-seam (E-04)", () => {
  const loopManifest = { name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: "loop" };

  it("warns when a looping emote's first and last poses differ", async () => {
    const glb = await syntheticGlb({ animation: { name: "Wave_Avatar", seconds: 2, loopSeam: false } });
    const zip = await syntheticZip({ kind: "emote", glb, manifest: loopManifest });
    const result = await validate(zip, { checks: ["loop-seam"] });
    const warnings = of(result, "loop-seam");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, "warning");
    assert.deepEqual(warnings[0].data?.bones, ["Avatar_Hips"]);
  });

  it("passes a clean loop", async () => {
    const glb = await syntheticGlb({ animation: { name: "Wave_Avatar", seconds: 2, loopSeam: true } });
    const zip = await syntheticZip({ kind: "emote", glb, manifest: loopManifest });
    const result = await validate(zip, { checks: ["loop-seam"] });
    assert.equal(of(result, "loop-seam").length, 0);
  });

  it("is inapplicable when the emote does not loop", async () => {
    const zip = await syntheticZip({ kind: "emote" });
    const result = await validate(zip, { checks: ["loop-seam"] });
    assert.equal(result.checks.length, 0);
  });
});
