import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/index.js";
import { syntheticGlb, syntheticZip } from "./helpers/synthetic.js";

describe("measured values", () => {
  it("passing checks report what the item actually measures", async () => {
    const result = await validate(await syntheticZip());
    const byCheck = new Map(result.checks.map((c) => [c.check, c]));
    assert.match(byCheck.get("triangle-count")?.measured ?? "", /\d+ tris/);
    assert.match(byCheck.get("representations")?.measured ?? "", /body shape/);
    assert.match(byCheck.get("file-size")?.measured ?? "", /MB total/);
    assert.match(byCheck.get("material-count")?.measured ?? "", /material/);
    assert.match(byCheck.get("static-mesh")?.measured ?? "", /0 animations/);
  });

  it("emote checks measure duration and clips", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }));
    const byCheck = new Map(result.checks.map((c) => [c.check, c]));
    assert.match(byCheck.get("duration")?.measured ?? "", /2 s/);
    assert.match(byCheck.get("animation-clips")?.measured ?? "", /Pose_Avatar/);
  });

  it("a measurement never crashes a run", async () => {
    const result = await validate(await syntheticGlb(), { category: "hat" });
    assert.ok(result.checks.length > 0);
  });
});

it("reports embedded texture format and bit depth", async () => {
  const glb = await syntheticGlb({ texture: { size: 64 } });
  const result = await validate(glb, { category: "hat", checks: ["texture-format"] });
  assert.equal(result.checks[0]?.status, "passed");
  assert.equal(result.checks[0]?.measured, "PNG · 8-bit");
});

it("reports when no embedded textures exist", async () => {
  const result = await validate(await syntheticGlb(), { category: "hat", checks: ["texture-format"] });
  assert.equal(result.checks[0]?.measured, "No embedded textures");
});
