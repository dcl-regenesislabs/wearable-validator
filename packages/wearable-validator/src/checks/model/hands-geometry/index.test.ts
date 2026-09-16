import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, AVATAR_BONE_NAMES } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("hands-geometry (M-11)", () => {
  it("is not applicable outside hands_wear", async () => {
    const result = await validate(await wearableZip(), { checks: ["hands-geometry"] });
    assert.equal(result.checks.length, 0);
  });

  it("warns when weight is not on the hand bones (held prop)", async () => {
    const glb = await syntheticGlb(); // fully weighted to Avatar_Hips
    const zip = await syntheticZip({ glb, category: "hands_wear" });
    const result = await validate(zip, { checks: ["hands-geometry"] });
    const findings = found(result, "hands-geometry");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /held prop/);
  });

  it("passes when the item is skinned to hand bones", async () => {
    const leftHand = AVATAR_BONE_NAMES.indexOf("Avatar_LeftHand");
    const glb = await syntheticGlb({ skinData: { joints: [leftHand, 0, 0, 0], weights: [1, 0, 0, 0] } });
    const zip = await syntheticZip({ glb, category: "hands_wear" });
    const result = await validate(zip, { checks: ["hands-geometry"] });
    assert.equal(found(result, "hands-geometry").length, 0);
    assert.equal(status(result, "hands-geometry"), "passed");
  });
});
