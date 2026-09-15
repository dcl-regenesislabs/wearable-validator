import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { only } from "#test/helpers/findings.js";
import { wearableManifest } from "#test/helpers/manifest.js";

describe("name-description (S-07)", () => {
  it("errors on an over-long name", async () => {
    const zip = await syntheticZip({ manifest: wearableManifest({ name: "x".repeat(33) }) });
    const findings = only((await validate(zip, { checks: ["name-description"] })).findings, "name-description");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 33);
    assert.equal(findings[0].limit, 32);
  });

  it("errors on the forbidden character from the manifest", async () => {
    const zip = await syntheticZip({ manifest: wearableManifest({ name: "Hat: deluxe" }) });
    const findings = only((await validate(zip, { checks: ["name-description"] })).findings, "name-description");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].data?.character, ":");
  });

  it("errors on an over-long description and too many tags", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({ description: "d".repeat(65) }, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })
    });
    const findings = only((await validate(zip, { checks: ["name-description"] })).findings, "name-description");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => f.where === "description" && f.limit === 64));
    assert.ok(findings.some((f) => f.where === "tags" && f.limit === 20));
  });

  it("passes compliant text", async () => {
    const result = await validate(await syntheticZip(), { checks: ["name-description"] });
    assert.equal(only(result.findings, "name-description").length, 0);
  });
});
