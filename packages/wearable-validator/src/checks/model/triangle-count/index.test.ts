import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("triangle-count (M-01)", () => {
  it("errors when triangles exceed the category budget", async () => {
    const zip = await wearableZip({ triangles: 1600 }); // hat budget: 1500
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 1600);
    assert.equal(findings[0].limit, 1500);
    assert.equal(status(result, "triangle-count"), "failed");
  });

  it("pools hidden-slot budgets into the limit", async () => {
    const zip = await wearableZip({ triangles: 1600 }, { hides: ["mask"] }); // 1500 + 500
    const result = await validate(zip, { checks: ["triangle-count"] });
    assert.equal(found(result, "triangle-count").length, 0);
    assert.equal(status(result, "triangle-count"), "passed");
  });

  it("warns on TRIANGLE_STRIP/FAN primitives", async () => {
    const zip = await wearableZip({ stripVertices: 5 });
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /STRIP/);
  });

  it("excludes collider nodes from the count", async () => {
    const zip = await wearableZip({ triangles: 12, colliderTriangles: 5000 });
    const result = await validate(zip, { checks: ["triangle-count"] });
    assert.equal(found(result, "triangle-count").length, 0);
  });

  it("warns category-unknown on a bare GLB without a hint", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });
});
