import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { pngBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";

describe("gltf-valid (S-02)", () => {
  it("errors on a truncated GLB (declared length mismatch)", async () => {
    const glb = await syntheticGlb();
    const zip = await syntheticZip({ glb: glb.subarray(0, glb.length - 16) });
    const findings = only((await validate(zip, { checks: ["gltf-valid"] })).findings, "gltf-valid");
    assert.ok(findings.length >= 1);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => /corrupt|truncated/.test(f.message)));
  });

  it("errors on an invalid JSON chunk and surfaces the parse error", async () => {
    // hand-built container: magic + version + a JSON chunk that is not JSON
    const jsonBytes = enc("{oops   ");
    const glb = new Uint8Array(12 + 8 + jsonBytes.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, jsonBytes.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(jsonBytes, 20);
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-valid"] })).findings, "gltf-valid");
    assert.ok(findings.length >= 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => /not valid JSON/.test(f.message)));
    assert.ok(findings.some((f) => /failed to parse/.test(f.message)));
  });

  it("passes a well-formed GLB and is not applicable to facial features", async () => {
    const zip = await validate(await syntheticZip(), { checks: ["gltf-valid"] });
    assert.equal(only(zip.findings, "gltf-valid").length, 0);
    const facial = await validate(pngBytes(256, 256), { category: "eyes", checks: ["gltf-valid"] });
    assert.equal(facial.checks.length, 0);
  });
});
