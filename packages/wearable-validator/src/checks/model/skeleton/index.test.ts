import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, AVATAR_BONE_NAMES } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { wearableZip } from "#test/helpers/wearable-zip.js";

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
