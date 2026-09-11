import { describe, it } from "node:test";
import assert from "node:assert/strict";
import dclHashing from "@dcl/hashing";
import { validate } from "../../../index.js";
import { pngBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { only } from "#test/helpers/findings.js";

describe("content-integrity (S-09)", () => {
  it("is not applicable without an entity content list", async () => {
    const result = await validate(await syntheticZip(), { checks: ["content-integrity"] });
    assert.equal(result.checks.length, 0);
    assert.equal(result.findings.length, 0);
  });

  it("errors on a hash mismatch", async () => {
    const glb = await syntheticGlb();
    const files = new Map([["model.glb", glb]]);
    const content = [{ file: "model.glb", hash: "bafybeigdyrztotallywrong" }];
    const findings = only((await validate({ files, content }, { checks: ["content-integrity"] })).findings, "content-integrity");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /does not match/);
  });

  it("errors both directions: declared-but-missing and present-but-undeclared", async () => {
    const glb = await syntheticGlb();
    const files = new Map([
      ["model.glb", glb],
      ["stray.png", pngBytes(8, 8)]
    ]);
    const content = [
      { file: "model.glb", hash: await dclHashing.hashV1(glb) },
      { file: "ghost.png", hash: "bafybeighost" }
    ];
    const findings = only((await validate({ files, content }, { checks: ["content-integrity"] })).findings, "content-integrity");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => f.where === "ghost.png" && /missing/.test(f.message)));
    assert.ok(findings.some((f) => f.where === "stray.png" && /not declared/.test(f.message)));
  });

  it("passes when every hash matches in both directions", async () => {
    const glb = await syntheticGlb();
    const thumb = pngBytes(256, 256);
    const files = new Map([
      ["model.glb", glb],
      ["thumbnail.png", thumb]
    ]);
    const content = [
      { file: "model.glb", hash: await dclHashing.hashV1(glb) },
      { file: "thumbnail.png", hash: await dclHashing.hashV1(thumb) }
    ];
    const result = await validate({ files, content }, { checks: ["content-integrity"] });
    assert.equal(only(result.findings, "content-integrity").length, 0);
    assert.equal(result.checks[0]?.status, "passed");
  });
});
