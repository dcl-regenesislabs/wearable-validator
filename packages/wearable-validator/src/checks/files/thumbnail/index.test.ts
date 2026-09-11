import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { pngBytes, syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";

describe("thumbnail (S-06)", () => {
  it("errors when the thumbnail is missing", async () => {
    const zip = await syntheticZip({ thumbnail: null });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not found/);
  });

  it("errors when the thumbnail is not a PNG", async () => {
    const zip = await syntheticZip({ thumbnail: enc("JFIF-ish bytes") });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not a PNG/);
  });

  it("errors above the max dimension", async () => {
    const zip = await syntheticZip({ thumbnail: pngBytes(1030, 1030) });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.ok(findings.some((f) => f.severity === "error" && f.limit === "1024×1024"));
  });

  it("warns on a non-recommended size", async () => {
    const zip = await syntheticZip({ thumbnail: pngBytes(300, 300) });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].limit, "256×256");
  });

  it("warns when there is no alpha channel and when nothing is transparent", async () => {
    const noAlpha = only((await validate(await syntheticZip({ thumbnail: pngBytes(256, 256, true, 3) }), { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(noAlpha.length, 1);
    assert.equal(noAlpha[0].severity, "warning");
    assert.match(noAlpha[0].message, /alpha/);

    const opaque = only((await validate(await syntheticZip({ thumbnail: pngBytes(256, 256, true) }), { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(opaque.length, 1);
    assert.equal(opaque[0].severity, "warning");
    assert.match(opaque[0].message, /transparent/);
  });

  it("passes a transparent 256×256 PNG", async () => {
    const result = await validate(await syntheticZip(), { checks: ["thumbnail"] });
    assert.equal(only(result.findings, "thumbnail").length, 0);
  });
});
