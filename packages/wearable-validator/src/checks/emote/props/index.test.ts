import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../../../index.js";
import { of, runChecks } from "#test/helpers/emote.js";

describe("props (E-07)", () => {
  it("is inapplicable without an Armature_Prop", async () => {
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 2 } }, ["props"]);
    assert.equal(result.checks.length, 0);
  });

  it("errors when the prop exceeds the triangle budget", async () => {
    const result = await runChecks({ prop: { triangles: 4000 } }, ["props"]);
    const errors = of(result, "props").filter((f) => f.data?.metric === "triangles");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, "error");
    assert.equal(errors[0].measured, 4000);
    assert.equal(errors[0].limit, manifest.emote.propMaxTriangles);
  });

  it("errors when the prop has too many materials and textures", async () => {
    const result = await runChecks({ prop: { materials: 3, texturedMaterials: 3 } }, ["props"]);
    const findings = of(result, "props");
    assert.ok(findings.some((f) => f.data?.metric === "materials" && f.severity === "error"));
    assert.ok(findings.some((f) => f.data?.metric === "textures" && f.severity === "error"));
  });

  it("errors when the prop rig has too many bones", async () => {
    const result = await runChecks({ prop: { bones: manifest.emote.propMaxBones + 1 } }, ["props"]);
    const errors = of(result, "props").filter((f) => f.data?.metric === "bones");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, "error");
  });

  it("passes a prop within all budgets", async () => {
    const result = await runChecks({ prop: { triangles: 100, materials: 2, texturedMaterials: 2, bones: 4 } }, ["props"]);
    assert.equal(of(result, "props").length, 0);
  });
});
