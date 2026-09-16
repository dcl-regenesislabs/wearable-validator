import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("texture-maps (M-05)", () => {
  it("errors for each forbidden map, naming it", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      textureImages: [
        { slot: "normal", size: 32 },
        { slot: "metallicRoughness", size: 16 },
        { slot: "occlusion", size: 8 }
      ]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-maps"] });
    const findings = found(result, "texture-maps");
    assert.equal(findings.length, 3);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.deepEqual(
      findings.map((f) => f.data?.map).sort(),
      ["metallicRoughnessTexture", "normalTexture", "occlusionTexture"]
    );
  });

  it("passes base color + emissive", async () => {
    const glb = await syntheticGlb({ texture: { size: 64 }, textureImages: [{ slot: "emissive", size: 32 }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-maps"] });
    assert.equal(found(result, "texture-maps").length, 0);
  });
});
