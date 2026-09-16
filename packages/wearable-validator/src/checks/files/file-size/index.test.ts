import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { padBytes } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";

describe("file-size (S-05)", () => {
  it("errors on total size and on the model-alone headroom", async () => {
    const glb = padBytes(await syntheticGlb(), 3_500_000);
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.equal(findings[0].limit, 3145728); // total, from the manifest
    assert.equal(findings[1].limit, 3145728 - 1048576); // model alone ≤ limit − headroom
    assert.equal(findings[1].where, "model.glb");
  });

  it("gives skins the skin budget", async () => {
    const glb = padBytes(await syntheticGlb(), 4_000_000);
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });

  it("applies the emote budget to emotes", async () => {
    const glb = padBytes(await syntheticGlb({ animation: { name: "Pose_Avatar", seconds: 2 } }), 3_500_000);
    const findings = only((await validate(await syntheticZip({ glb, kind: "emote" }), { checks: ["file-size"] })).findings, "file-size");
    assert.ok(findings.length >= 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, 3145728);
    assert.match(findings[0].message, /emote/);
  });

  it("warns once with category-unknown on a bare GLB without a hint", async () => {
    const findings = only((await validate(await syntheticGlb(), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });

  it("passes a small wearable", async () => {
    const result = await validate(await syntheticZip(), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });
});
