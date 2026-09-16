import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

describe("static-mesh (M-13)", () => {
  it("warns on animation clips in a wearable GLB", async () => {
    const zip = await wearableZip({ animation: { name: "Wave", seconds: 1 } });
    const result = await validate(zip, { checks: ["static-mesh"] });
    const findings = found(result, "static-mesh");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /animation/);
  });

  it("warns on morph targets (shape keys)", async () => {
    const zip = await wearableZip({ morphTarget: true });
    const result = await validate(zip, { checks: ["static-mesh"] });
    const findings = found(result, "static-mesh");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /morph|shape key/i);
  });

  it("passes a static wearable and skips emotes", async () => {
    const clean = await validate(await wearableZip(), { checks: ["static-mesh"] });
    assert.equal(status(clean, "static-mesh"), "passed");
    const emote = await validate(await syntheticZip({ kind: "emote" }), { checks: ["static-mesh"] });
    assert.equal(emote.checks.length, 0);
  });
});
