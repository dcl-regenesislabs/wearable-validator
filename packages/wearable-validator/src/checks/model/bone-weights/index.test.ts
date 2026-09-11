import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("bone-weights (M-10)", () => {
  it("errors when weights don't sum to 1", async () => {
    const zip = await wearableZip({ skinData: { weights: [0.5, 0.2, 0, 0] } });
    const result = await validate(zip, { checks: ["bone-weights"] });
    const findings = found(result, "bone-weights");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /sum to 1/);
  });

  it("errors when a second influence set carries non-zero weights", async () => {
    const zip = await wearableZip({
      skinData: { weights: [0.8, 0, 0, 0], secondSet: { joints: [1, 0, 0, 0], weights: [0.2, 0, 0, 0] } }
    });
    const result = await validate(zip, { checks: ["bone-weights"] });
    const findings = found(result, "bone-weights");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /influences/);
  });

  it("warns on zero-weight vertices with a count", async () => {
    const zip = await wearableZip({ skinData: { zeroWeightVertices: 5 } });
    const result = await validate(zip, { checks: ["bone-weights"] });
    const findings = found(result, "bone-weights");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].measured, 5);
  });

  it("dequantizes normalized uint8 weights before summing", async () => {
    const zip = await wearableZip({ skinData: { normalizedWeights: true } }); // 255/255 = 1.0
    const result = await validate(zip, { checks: ["bone-weights"] });
    assert.equal(found(result, "bone-weights").length, 0);
    assert.equal(status(result, "bone-weights"), "passed");
  });

  it("passes clean float weights", async () => {
    const result = await validate(await wearableZip(), { checks: ["bone-weights"] });
    assert.equal(status(result, "bone-weights"), "passed");
  });
});
