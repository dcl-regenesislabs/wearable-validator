import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../../../index.js";
import { of, runChecks } from "#test/helpers/emote.js";

describe("root-motion (E-05)", () => {
  it("errors when the hips travel too far horizontally", async () => {
    const result = await runChecks(
      { animations: [{ name: "Run_Avatar", seconds: 2, values: [0, 0, 0, 2, 0, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const errors = of(result, "root-motion").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 2);
    assert.equal(errors[0].limit, manifest.emote.rootMotion.horizontalErrorMeters);
  });

  it("warns between the vertical warn and error thresholds", async () => {
    const result = await runChecks(
      { animations: [{ name: "Jump_Avatar", seconds: 2, values: [0, 0, 0, 0, 2, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("errors above the vertical hard limit", async () => {
    const result = await runChecks(
      { animations: [{ name: "Fly_Avatar", seconds: 2, values: [0, 0, 0, 0, 5, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
  });

  it("passes small hip motion", async () => {
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 2 } }, ["root-motion"]);
    assert.equal(of(result, "root-motion").length, 0);
  });
});
