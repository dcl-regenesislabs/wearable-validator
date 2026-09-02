import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/index.js";
import { manifest } from "../src/manifest/index.js";
import { pngBytes, syntheticGlb, syntheticZip, type SyntheticOptions } from "./helpers/synthetic.js";
import type { Finding, Result } from "../src/types.js";

async function runChecks(glbOptions: SyntheticOptions, checks: string[]): Promise<Result> {
  const glb = await syntheticGlb(glbOptions);
  return validate(glb, { checks, itemType: "emote" });
}

function of(result: Result, check: string): Finding[] {
  return result.findings.filter((f) => f.check === check);
}

describe("duration (E-01)", () => {
  it("errors when the animation exceeds the duration limit", async () => {
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 12 } }, ["duration"]);
    const errors = of(result, "duration").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 12);
    assert.equal(errors[0].limit, manifest.emote.maxDurationSeconds);
  });

  it("warns when keyframe spacing implies an fps far from 30", async () => {
    // 3 keys over 2 s → 1 s spacing → ~1 fps
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 2 } }, ["duration"]);
    const warnings = of(result, "duration").filter((f) => f.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].data?.advisory, true);
  });

  it("passes a 30 fps clip within the limit", async () => {
    const times = Array.from({ length: 61 }, (_, i) => i / 30);
    const result = await runChecks({ animations: [{ name: "Wave_Avatar", seconds: 2, times }] }, ["duration"]);
    assert.equal(of(result, "duration").length, 0);
  });

  it("is inapplicable to wearables", async () => {
    const zip = await syntheticZip();
    const result = await validate(zip, { checks: ["duration"] });
    assert.equal(result.checks.length, 0);
  });
});

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

describe("loop-seam (E-04)", () => {
  const loopManifest = { name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: "loop" };

  it("warns when a looping emote's first and last poses differ", async () => {
    const glb = await syntheticGlb({ animation: { name: "Wave_Avatar", seconds: 2, loopSeam: false } });
    const zip = await syntheticZip({ kind: "emote", glb, manifest: loopManifest });
    const result = await validate(zip, { checks: ["loop-seam"] });
    const warnings = of(result, "loop-seam");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, "warning");
    assert.deepEqual(warnings[0].data?.bones, ["Avatar_Hips"]);
  });

  it("passes a clean loop", async () => {
    const glb = await syntheticGlb({ animation: { name: "Wave_Avatar", seconds: 2, loopSeam: true } });
    const zip = await syntheticZip({ kind: "emote", glb, manifest: loopManifest });
    const result = await validate(zip, { checks: ["loop-seam"] });
    assert.equal(of(result, "loop-seam").length, 0);
  });

  it("is inapplicable when the emote does not loop", async () => {
    const zip = await syntheticZip({ kind: "emote" });
    const result = await validate(zip, { checks: ["loop-seam"] });
    assert.equal(result.checks.length, 0);
  });
});

describe("root-motion (E-05)", () => {
  it("errors when the hips travel too far horizontally", async () => {
    const result = await runChecks(
      { animations: [{ name: "Run_Avatar", seconds: 2, values: [0, 0, 0, 2, 0, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const errors = of(result, "root-motion").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 2);
    assert.equal(errors[0].limit, manifest.emote.rootMotion.horizontalErrorMeters);
  });

  it("warns between the vertical warn and error thresholds", async () => {
    const result = await runChecks(
      { animations: [{ name: "Jump_Avatar", seconds: 2, values: [0, 0, 0, 0, 2, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("errors above the vertical hard limit", async () => {
    const result = await runChecks(
      { animations: [{ name: "Fly_Avatar", seconds: 2, values: [0, 0, 0, 0, 5, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
  });

  it("passes small hip motion", async () => {
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 2 } }, ["root-motion"]);
    assert.equal(of(result, "root-motion").length, 0);
  });
});

describe("clip-names (E-06)", () => {
  it("errors on lowercase start and invalid characters", async () => {
    const result = await runChecks({ animation: { name: "wave avatar!", seconds: 2 } }, ["clip-names"]);
    const errors = of(result, "clip-names").filter((f) => f.severity === "error");
    assert.equal(errors.length, 2);
    assert.ok(errors.some((f) => /capital/.test(f.message)));
    assert.ok(errors.some((f) => /underscores/.test(f.message)));
  });

  it("warns on uncapitalized words after underscores", async () => {
    const result = await runChecks({ animation: { name: "Wave_pose", seconds: 2 } }, ["clip-names"]);
    const findings = of(result, "clip-names");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("passes a well-formed name", async () => {
    const result = await runChecks({ animation: { name: "Wave_Pose_Avatar", seconds: 2 } }, ["clip-names"]);
    assert.equal(of(result, "clip-names").length, 0);
  });
});

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

describe("audio (E-08)", () => {
  it("errors on an unsupported audio format", async () => {
    const zip = await syntheticZip({ kind: "emote", extraFiles: { "sound.wav": new Uint8Array(16) } });
    const result = await validate(zip, { checks: ["audio"] });
    const errors = of(result, "audio").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].where, "sound.wav");
  });

  it("errors when audio exceeds the byte budget", async () => {
    const zip = await syntheticZip({ kind: "emote", extraFiles: { "big.mp3": new Uint8Array(manifest.fileSize.audioBytes + 1) } });
    const result = await validate(zip, { checks: ["audio"] });
    const errors = of(result, "audio").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].limit, manifest.fileSize.audioBytes);
  });

  it("warns when an audio file's duration can't be read", async () => {
    const zip = await syntheticZip({ kind: "emote", extraFiles: { "sound.mp3": pngBytes(8, 8) } });
    const result = await validate(zip, { checks: ["audio"] });
    const warnings = of(result, "audio").filter((f) => f.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /duration/);
  });

  it("passes an emote without audio", async () => {
    const zip = await syntheticZip({ kind: "emote" });
    const result = await validate(zip, { checks: ["audio"] });
    assert.equal(of(result, "audio").length, 0);
  });
});

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
