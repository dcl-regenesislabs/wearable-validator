import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("bounding-box (M-08)", () => {
  it("errors when the model exceeds the max dimensions", async () => {
    const zip = await wearableZip({ scale: 3 }); // 3 m > 2.42 m
    const result = await validate(zip, { checks: ["bounding-box"] });
    const findings = found(result, "bounding-box");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(status(result, "bounding-box"), "failed");
  });

  it("passes a model that fits", async () => {
    const result = await validate(await wearableZip(), { checks: ["bounding-box"] });
    assert.equal(status(result, "bounding-box"), "passed");
  });
});
