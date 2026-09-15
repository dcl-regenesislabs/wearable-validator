import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { of, runChecks } from "#test/helpers/emote.js";

describe("bone-targets (E-03)", () => {
  it("errors when a clip animates a mesh node", async () => {
    const result = await runChecks({ animations: [{ name: "Wave_Avatar", seconds: 2, targetNode: "cube_node" }] }, ["bone-targets"]);
    const errors = of(result, "bone-targets").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /mesh/);
  });

  it("errors on a non-canonical bone name", async () => {
    const result = await runChecks(
      { animations: [{ name: "Wave_Avatar", seconds: 2, targetNode: "Armature" }] },
      ["bone-targets"]
    );
    const errors = of(result, "bone-targets").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Armature/);
  });

  it("errors when a non-prop clip animates a prop bone", async () => {
    const result = await runChecks(
      { prop: { bones: 2 }, animations: [{ name: "Wave_Avatar", seconds: 2, targetNode: "Prop_Bone_0" }] },
      ["bone-targets"]
    );
    const errors = of(result, "bone-targets").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /_Prop/);
  });

  it("accepts avatar bones, springbones and prop bones from a prop clip", async () => {
    const result = await runChecks(
      {
        bones: undefined,
        prop: { bones: 2 },
        animations: [
          { name: "Wave_Avatar", seconds: 2, targetBone: "Avatar_Hips" },
          { name: "Wave_Prop", seconds: 2, targetNode: "Prop_Bone_0" }
        ]
      },
      ["bone-targets"]
    );
    assert.equal(of(result, "bone-targets").length, 0);
  });
});
