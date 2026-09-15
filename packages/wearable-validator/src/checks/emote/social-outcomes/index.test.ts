import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import type { Result } from "../../../index.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { of } from "#test/helpers/emote.js";

describe("social-outcomes (E-09)", () => {
  async function runSocial(emoteData: Record<string, unknown>): Promise<Result> {
    const glb = await syntheticGlb({ animation: { name: "Wave_Avatar", seconds: 2 } });
    const files = new Map([["model.glb", glb]]);
    const metadata = { name: "Social", description: "synthetic", emoteDataADR74: { category: "fun", loop: false, ...emoteData } };
    return validate({ files, metadata }, { checks: ["social-outcomes"] });
  }

  it("errors when there are too many outcomes", async () => {
    const outcomes = Array.from({ length: manifest.emote.maxSocialOutcomes + 1 }, () => ({ clips: ["Wave_Avatar"] }));
    const result = await runSocial({ outcomes });
    const errors = of(result, "social-outcomes").filter((f) => typeof f.measured === "number");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, "error");
    assert.equal(errors[0].limit, manifest.emote.maxSocialOutcomes);
  });

  it("errors on startAnimation without outcomes", async () => {
    const result = await runSocial({ startAnimation: ["Wave_Avatar"] });
    const errors = of(result, "social-outcomes").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /startAnimation/);
  });

  it("errors when an outcome references a clip missing from the GLB", async () => {
    const result = await runSocial({ outcomes: [{ clips: ["Missing_Avatar"] }] });
    const errors = of(result, "social-outcomes").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].where, "Missing_Avatar");
  });

  it("passes outcomes whose clips all exist", async () => {
    const result = await runSocial({ outcomes: [{ clips: ["Wave_Avatar"] }] });
    assert.equal(of(result, "social-outcomes").length, 0);
  });

  it("is inapplicable without outcomes or startAnimation", async () => {
    const result = await runSocial({});
    assert.equal(result.checks.length, 0);
  });
});
