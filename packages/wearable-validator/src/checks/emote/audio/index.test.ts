import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { pngBytes, syntheticZip } from "#test/helpers/synthetic.js";
import { of } from "#test/helpers/emote.js";

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
