import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { of, runChecks } from "#test/helpers/emote.js";

describe("clip-names (E-06)", () => {
  it("errors on lowercase start and invalid characters", async () => {
    const result = await runChecks({ animation: { name: "wave avatar!", seconds: 2 } }, ["clip-names"]);
    const errors = of(result, "clip-names").filter((f) => f.severity === "error");
    assert.equal(errors.length, 2);
    assert.ok(errors.some((f) => /capital/.test(f.message)));
    assert.ok(errors.some((f) => /underscores/.test(f.message)));
  });

  it("warns on uncapitalized words after underscores", async () => {
    const result = await runChecks({ animation: { name: "Wave_pose", seconds: 2 } }, ["clip-names"]);
    const findings = of(result, "clip-names");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("passes a well-formed name", async () => {
    const result = await runChecks({ animation: { name: "Wave_Pose_Avatar", seconds: 2 } }, ["clip-names"]);
    assert.equal(of(result, "clip-names").length, 0);
  });
});
