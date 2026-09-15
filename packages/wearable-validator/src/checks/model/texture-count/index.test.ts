import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("texture-count (M-02)", () => {
  it("errors when unique texture images exceed the default limit", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      extraMaterialDefs: [
        { name: "Second_MAT", textures: [{ size: 32 }] },
        { name: "Third_MAT", textures: [{ size: 16 }] }
      ]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-count"] });
    const findings = found(result, "texture-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 3);
    assert.equal(findings[0].limit, 2);
    assert.equal(findings[0].where, "model.glb");
  });

  it("excludes AvatarSkin_MAT textures and applies the skin limit", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      extraMaterialDefs: [
        { name: "AvatarSkin_MAT", textures: [{ size: 32 }, { slot: "emissive", size: 16 }] },
        { name: "Detail_MAT", textures: [{ size: 8 }] }
      ]
    });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["texture-count"] });
    assert.equal(found(result, "texture-count").length, 0);
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["texture-count"] });
    assert.equal(result.checks.length, 0);
    assert.equal(result.findings.length, 0);
  });
});
