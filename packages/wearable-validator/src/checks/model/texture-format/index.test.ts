import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode as encodeJpeg } from "jpeg-js";
import { validate } from "../../../index.js";
import { found } from "#test/helpers/findings.js";
import { png16Bytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("texture-format (M-04)", () => {
  it("errors on 16-bit PNGs", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: png16Bytes(64, 64), name: "deep" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-format"] });
    const findings = found(result, "texture-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "16-bit");
  });

  it("errors on non-PNG/JPEG images", async () => {
    const glb = await syntheticGlb({
      textureImages: [{ bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), mimeType: "image/webp", name: "webp" }]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-format"] });
    const findings = found(result, "texture-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /PNG or JPEG/);
  });

  it("passes 8-bit PNG and JPEG textures", async () => {
    const jpeg = encodeJpeg({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(128) }, 90).data;
    const glb = await syntheticGlb({
      texture: { size: 64 },
      textureImages: [{ slot: "emissive", bytes: new Uint8Array(jpeg), mimeType: "image/jpeg", name: "glow" }]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-format"] });
    assert.equal(found(result, "texture-format").length, 0);
  });
});
