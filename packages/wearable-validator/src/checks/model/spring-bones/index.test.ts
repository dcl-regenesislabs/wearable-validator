import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest, AVATAR_BONE_NAMES } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

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
