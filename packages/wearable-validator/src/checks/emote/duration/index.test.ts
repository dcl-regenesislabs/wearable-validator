import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { of, runChecks } from "#test/helpers/emote.js";

describe("duration (E-01)", () => {
  it("errors when the animation exceeds the duration limit", async () => {
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 12 } }, ["duration"]);
    const errors = of(result, "duration").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 12);
    assert.equal(errors[0].limit, manifest.emote.maxDurationSeconds);
  });

  it("warns when keyframe spacing implies an fps far from 30", async () => {
    // 3 keys over 2 s → 1 s spacing → ~1 fps
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 2 } }, ["duration"]);
    const warnings = of(result, "duration").filter((f) => f.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].data?.advisory, true);
  });

  it("passes a 30 fps clip within the limit", async () => {
    const times = Array.from({ length: 61 }, (_, i) => i / 30);
    const result = await runChecks({ animations: [{ name: "Wave_Avatar", seconds: 2, times }] }, ["duration"]);
    assert.equal(of(result, "duration").length, 0);
  });

  it("is inapplicable to wearables", async () => {
    const zip = await syntheticZip();
    const result = await validate(zip, { checks: ["duration"] });
    assert.equal(result.checks.length, 0);
  });
});
