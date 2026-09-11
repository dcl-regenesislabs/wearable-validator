import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { only } from "#test/helpers/findings.js";

describe("category (S-08)", () => {
  it("errors on an unknown category", async () => {
    const zip = await syntheticZip({ category: "backpack" });
    const findings = only((await validate(zip, { checks: ["category"] })).findings, "category");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "backpack");
  });

  it("errors on body_shape", async () => {
    const zip = await syntheticZip({ category: "body_shape" });
    const findings = only((await validate(zip, { checks: ["category"] })).findings, "category");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /body_shape/);
  });

  it("passes a known category", async () => {
    const result = await validate(await syntheticZip({ category: "hat" }), { checks: ["category"] });
    assert.equal(only(result.findings, "category").length, 0);
  });
});
