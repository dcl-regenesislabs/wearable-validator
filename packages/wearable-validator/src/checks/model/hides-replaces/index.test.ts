import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("hides-replaces (M-12)", () => {
  it("warns when hides contains the item's own category", async () => {
    const zip = await wearableZip({}, { hides: ["hat"] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /own category/);
  });

  it("warns when replaces contains the item's own category", async () => {
    const zip = await wearableZip({}, { replaces: ["hat"] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("warns when a skin doesn't hide the full ADR-60 set", async () => {
    const zip = await wearableZip({}, { category: "skin", hides: [] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.deepEqual(findings[0].data?.missing, manifest.skinAutoHideSet);
  });

  it("passes a skin hiding the full set, and a plain wearable", async () => {
    const skin = await validate(await wearableZip({}, { category: "skin", hides: manifest.skinAutoHideSet }), { checks: ["hides-replaces"] });
    assert.equal(status(skin, "hides-replaces"), "passed");
    const hat = await validate(await wearableZip({}, { hides: ["mask"] }), { checks: ["hides-replaces"] });
    assert.equal(status(hat, "hides-replaces"), "passed");
  });

  it("is not applicable without metadata", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { checks: ["hides-replaces"], category: "hat" });
    assert.equal(result.checks.length, 0);
  });
});
