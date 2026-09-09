import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest, AVATAR_BONE_NAMES } from "../src/index.js";
import type { Result } from "../src/index.js";
import { syntheticGlb, syntheticZip, type SyntheticOptions } from "./helpers/synthetic.js";

async function wearableZip(glbOpts: SyntheticOptions = {}, data: Record<string, unknown> = {}): Promise<Uint8Array> {
  const glb = await syntheticGlb(glbOpts);
  return syntheticZip({
    glb,
    manifest: { name: "Test", description: "synthetic", rarity: "common", data: { category: "hat", ...data } }
  });
}

function found(result: Result, check: string) {
  return result.findings.filter((f) => f.check === check);
}

function status(result: Result, check: string) {
  return result.checks.find((c) => c.check === check)?.status;
}

describe("triangle-count (M-01)", () => {
  it("errors when triangles exceed the category budget", async () => {
    const zip = await wearableZip({ triangles: 1600 }); // hat budget: 1500
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 1600);
    assert.equal(findings[0].limit, 1500);
    assert.equal(status(result, "triangle-count"), "failed");
  });

  it("pools hidden-slot budgets into the limit", async () => {
    const zip = await wearableZip({ triangles: 1600 }, { hides: ["mask"] }); // 1500 + 500
    const result = await validate(zip, { checks: ["triangle-count"] });
    assert.equal(found(result, "triangle-count").length, 0);
    assert.equal(status(result, "triangle-count"), "passed");
  });

  it("warns on TRIANGLE_STRIP/FAN primitives", async () => {
    const zip = await wearableZip({ stripVertices: 5 });
    const result = await validate(zip, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /STRIP/);
  });

  it("excludes collider nodes from the count", async () => {
    const zip = await wearableZip({ triangles: 12, colliderTriangles: 5000 });
    const result = await validate(zip, { checks: ["triangle-count"] });
    assert.equal(found(result, "triangle-count").length, 0);
  });

  it("warns category-unknown on a bare GLB without a hint", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { checks: ["triangle-count"] });
    const findings = found(result, "triangle-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });
});

describe("bounding-box (M-08)", () => {
  it("errors when the model exceeds the max dimensions", async () => {
    const zip = await wearableZip({ scale: 3 }); // 3 m > 2.42 m
    const result = await validate(zip, { checks: ["bounding-box"] });
    const findings = found(result, "bounding-box");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(status(result, "bounding-box"), "failed");
  });

  it("passes a model that fits", async () => {
    const result = await validate(await wearableZip(), { checks: ["bounding-box"] });
    assert.equal(status(result, "bounding-box"), "passed");
  });
});

describe("skeleton (M-09)", () => {
  it("errors on unknown joints", async () => {
    const zip = await wearableZip({ bones: [...AVATAR_BONE_NAMES, "Weird_Bone"] });
    const result = await validate(zip, { checks: ["skeleton"] });
    const findings = found(result, "skeleton");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /Weird_Bone/);
  });

  it("hints at casing when a case-insensitive match exists", async () => {
    const zip = await wearableZip({ bones: [...AVATAR_BONE_NAMES, "avatar_hips"] });
    const result = await validate(zip, { checks: ["skeleton"] });
    const findings = found(result, "skeleton");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /casing/);
    assert.match(findings[0].message, /Avatar_Hips/);
  });

  it("errors on _end leaf bones", async () => {
    const zip = await wearableZip({ bones: [...AVATAR_BONE_NAMES, "Avatar_Head_end"] });
    const result = await validate(zip, { checks: ["skeleton"] });
    const findings = found(result, "skeleton");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /leaf/i);
  });

  it("errors when core bones are missing from a skinned model", async () => {
    const zip = await wearableZip({ bones: AVATAR_BONE_NAMES.filter((n) => n !== "Avatar_Head") });
    const result = await validate(zip, { checks: ["skeleton"] });
    const findings = found(result, "skeleton");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /Avatar_Head/);
  });

  it("tolerates spring bones and Armature; passes the canonical rig", async () => {
    const zip = await wearableZip({ bones: [...AVATAR_BONE_NAMES, "Hair_SpringBone_1"] });
    const result = await validate(zip, { checks: ["skeleton"] });
    assert.equal(found(result, "skeleton").length, 0);
    assert.equal(status(result, "skeleton"), "passed");
  });

  it("is not applicable to unskinned rigid accessories", async () => {
    const zip = await wearableZip({ skinned: false });
    const result = await validate(zip, { checks: ["skeleton"] });
    assert.equal(result.checks.length, 0);
  });

  it("is not applicable to emotes", async () => {
    const zip = await syntheticZip({ kind: "emote" });
    const result = await validate(zip, { checks: ["skeleton"] });
    assert.equal(result.checks.length, 0);
  });
});

describe("bone-weights (M-10)", () => {
  it("errors when weights don't sum to 1", async () => {
    const zip = await wearableZip({ skinData: { weights: [0.5, 0.2, 0, 0] } });
    const result = await validate(zip, { checks: ["bone-weights"] });
    const findings = found(result, "bone-weights");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /sum to 1/);
  });

  it("errors when a second influence set carries non-zero weights", async () => {
    const zip = await wearableZip({
      skinData: { weights: [0.8, 0, 0, 0], secondSet: { joints: [1, 0, 0, 0], weights: [0.2, 0, 0, 0] } }
    });
    const result = await validate(zip, { checks: ["bone-weights"] });
    const findings = found(result, "bone-weights");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /influences/);
  });

  it("warns on zero-weight vertices with a count", async () => {
    const zip = await wearableZip({ skinData: { zeroWeightVertices: 5 } });
    const result = await validate(zip, { checks: ["bone-weights"] });
    const findings = found(result, "bone-weights");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].measured, 5);
  });

  it("dequantizes normalized uint8 weights before summing", async () => {
    const zip = await wearableZip({ skinData: { normalizedWeights: true } }); // 255/255 = 1.0
    const result = await validate(zip, { checks: ["bone-weights"] });
    assert.equal(found(result, "bone-weights").length, 0);
    assert.equal(status(result, "bone-weights"), "passed");
  });

  it("passes clean float weights", async () => {
    const result = await validate(await wearableZip(), { checks: ["bone-weights"] });
    assert.equal(status(result, "bone-weights"), "passed");
  });
});

describe("hands-geometry (M-11)", () => {
  it("is not applicable outside hands_wear", async () => {
    const result = await validate(await wearableZip(), { checks: ["hands-geometry"] });
    assert.equal(result.checks.length, 0);
  });

  it("warns when weight is not on the hand bones (held prop)", async () => {
    const glb = await syntheticGlb(); // fully weighted to Avatar_Hips
    const zip = await syntheticZip({ glb, category: "hands_wear" });
    const result = await validate(zip, { checks: ["hands-geometry"] });
    const findings = found(result, "hands-geometry");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /held prop/);
  });

  it("passes when the item is skinned to hand bones", async () => {
    const leftHand = AVATAR_BONE_NAMES.indexOf("Avatar_LeftHand");
    const glb = await syntheticGlb({ skinData: { joints: [leftHand, 0, 0, 0], weights: [1, 0, 0, 0] } });
    const zip = await syntheticZip({ glb, category: "hands_wear" });
    const result = await validate(zip, { checks: ["hands-geometry"] });
    assert.equal(found(result, "hands-geometry").length, 0);
    assert.equal(status(result, "hands-geometry"), "passed");
  });
});

describe("hides-replaces (M-12)", () => {
  it("warns when hides contains the item's own category", async () => {
    const zip = await wearableZip({}, { hides: ["hat"] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /own category/);
  });

  it("warns when replaces contains the item's own category", async () => {
    const zip = await wearableZip({}, { replaces: ["hat"] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("warns when a skin doesn't hide the full ADR-60 set", async () => {
    const zip = await wearableZip({}, { category: "skin", hides: [] });
    const result = await validate(zip, { checks: ["hides-replaces"] });
    const findings = found(result, "hides-replaces");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.deepEqual(findings[0].data?.missing, manifest.skinAutoHideSet);
  });

  it("passes a skin hiding the full set, and a plain wearable", async () => {
    const skin = await validate(await wearableZip({}, { category: "skin", hides: manifest.skinAutoHideSet }), { checks: ["hides-replaces"] });
    assert.equal(status(skin, "hides-replaces"), "passed");
    const hat = await validate(await wearableZip({}, { hides: ["mask"] }), { checks: ["hides-replaces"] });
    assert.equal(status(hat, "hides-replaces"), "passed");
  });

  it("is not applicable without metadata", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb, { checks: ["hides-replaces"], category: "hat" });
    assert.equal(result.checks.length, 0);
  });
});

describe("static-mesh (M-13)", () => {
  it("warns on animation clips in a wearable GLB", async () => {
    const zip = await wearableZip({ animation: { name: "Wave", seconds: 1 } });
    const result = await validate(zip, { checks: ["static-mesh"] });
    const findings = found(result, "static-mesh");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /animation/);
  });

  it("warns on morph targets (shape keys)", async () => {
    const zip = await wearableZip({ morphTarget: true });
    const result = await validate(zip, { checks: ["static-mesh"] });
    const findings = found(result, "static-mesh");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /morph|shape key/i);
  });

  it("passes a static wearable and skips emotes", async () => {
    const clean = await validate(await wearableZip(), { checks: ["static-mesh"] });
    assert.equal(status(clean, "static-mesh"), "passed");
    const emote = await validate(await syntheticZip({ kind: "emote" }), { checks: ["static-mesh"] });
    assert.equal(emote.checks.length, 0);
  });
});

describe("spring-bones (M-14)", () => {
  it("warns when the GLB has more spring bones than the limit", async () => {
    const extras = Array.from({ length: manifest.skeleton.maxSpringBones + 1 }, (_, i) => `Tail_SpringBone_${i}`);
    const zip = await wearableZip({ bones: [...AVATAR_BONE_NAMES, ...extras] });
    const result = await validate(zip, { checks: ["spring-bones"] });
    const findings = found(result, "spring-bones");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].measured, manifest.skeleton.maxSpringBones + 1);
    assert.equal(findings[0].limit, manifest.skeleton.maxSpringBones);
  });

  it("passes when the spring-bone count is within the limit", async () => {
    const zip = await wearableZip({ bones: [...AVATAR_BONE_NAMES, "Hair_SpringBone_1", "Hair_SpringBone_2"] });
    const result = await validate(zip, { checks: ["spring-bones"] });
    assert.equal(found(result, "spring-bones").length, 0);
    assert.equal(status(result, "spring-bones"), "passed");
  });

  it("errors on springBones metadata values outside the ADR-316 ranges", async () => {
    const glb = await syntheticGlb();
    const metadata = {
      name: "Test",
      description: "synthetic",
      rarity: "common",
      data: {
        category: "hat",
        representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"] }],
        springBones: {
          version: 1,
          models: { hash1: { Hair_springbone_1: { stiffness: 9, gravityPower: 0, drag: 0.5, gravityDir: [0, -20, 0] } } }
        }
      }
    };
    const result = await validate({ files: new Map([["model.glb", glb]]), metadata }, { checks: ["spring-bones"] });
    const findings = found(result, "spring-bones");
    assert.equal(findings.length, 2); // stiffness 9 > 4, gravityDir −20 < −10
    for (const f of findings) {
      assert.equal(f.severity, "error");
      assert.equal(f.where, "Hair_springbone_1");
    }
  });

  it("passes valid springBones metadata", async () => {
    const glb = await syntheticGlb();
    const metadata = {
      name: "Test",
      description: "synthetic",
      rarity: "common",
      data: {
        category: "hat",
        representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"] }],
        springBones: {
          version: 1,
          models: { hash1: { Hair_springbone_1: { stiffness: 2, gravityPower: 0, drag: 0.5, gravityDir: [0, -1, 0] } } }
        }
      }
    };
    const result = await validate({ files: new Map([["model.glb", glb]]), metadata }, { checks: ["spring-bones"] });
    assert.equal(found(result, "spring-bones").length, 0);
    assert.equal(status(result, "spring-bones"), "passed");
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["spring-bones"] });
    assert.equal(result.checks.length, 0);
  });
});
