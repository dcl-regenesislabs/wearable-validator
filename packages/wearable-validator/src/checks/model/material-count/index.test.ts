import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("material-count (M-06)", () => {
  it("errors above the default limit", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "Third_MAT" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
    const findings = found(result, "material-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 3);
    assert.equal(findings[0].limit, 2);
  });

  it("excludes AvatarSkin_MAT from the count", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "AvatarSkin_MAT" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
    assert.equal(found(result, "material-count").length, 0);
  });

  it("allows 5 materials for skins", async () => {
    const glb = await syntheticGlb({
      extraMaterialDefs: [{ name: "M2" }, { name: "M3" }, { name: "M4" }, { name: "M5" }]
    });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-count"] });
    assert.equal(found(result, "material-count").length, 0);
  });
});
