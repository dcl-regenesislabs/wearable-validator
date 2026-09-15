import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../../../index.js";
import { of, runChecks } from "#test/helpers/emote.js";

describe("animation-clips (E-02)", () => {
  it("errors when there are more clips than allowed", async () => {
    const result = await runChecks(
      {
        animations: [
          { name: "A_Avatar", seconds: 2 },
          { name: "B_Prop", seconds: 2 },
          { name: "C_Extra", seconds: 2 }
        ]
      },
      ["animation-clips"]
    );
    const errors = of(result, "animation-clips").filter((f) => f.severity === "error");
    assert.ok(errors.some((f) => f.measured === 3 && f.limit === manifest.emote.maxClipsWithProps));
  });

  it("errors when two clips lack the _Avatar/_Prop suffixes", async () => {
    const result = await runChecks(
      { animations: [{ name: "Foo", seconds: 2 }, { name: "Bar", seconds: 2 }] },
      ["animation-clips"]
    );
    const errors = of(result, "animation-clips").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /_Avatar/);
  });

  it("errors when the prop clip length diverges from the avatar clip", async () => {
    const result = await runChecks(
      { animations: [{ name: "Wave_Avatar", seconds: 2 }, { name: "Wave_Prop", seconds: 3 }] },
      ["animation-clips"]
    );
    const errors = of(result, "animation-clips").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Wave_Prop/);
  });

  it("errors on an emote with no animation clips at all", async () => {
    const result = await runChecks({}, ["animation-clips"]);
    const errors = of(result, "animation-clips").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 0);
  });

  it("passes a matching _Avatar/_Prop pair", async () => {
    const result = await runChecks(
      { animations: [{ name: "Wave_Avatar", seconds: 2 }, { name: "Wave_Prop", seconds: 2 }] },
      ["animation-clips"]
    );
    assert.equal(of(result, "animation-clips").length, 0);
  });
});
