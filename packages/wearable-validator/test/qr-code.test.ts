import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode as encodePng } from "fast-png";
import { encode as encodeJpeg } from "jpeg-js";
import { validate } from "../src/index.js";
import { syntheticGlb, syntheticZip } from "./helpers/synthetic.js";

// Version-2 QR module matrix for "https://example.com/qr" (generated once with the `qrcode`
// package, stored as packed bits — no binary fixture in git).
const QR_SIZE = 25;
const QR_HEX =
  "fe04bfc107d06ea88bb757e5dbab4aec165907faaafe01a500be2c3e5cb6288095e56a3c7619fb76bc2f54aae804f7" +
  "6117f1ae4efa0051c63f972af056118baf1fbdd56b7eea9c1b0499b9feaa7f8";

function qrRgba(scale = 8, quiet = 4): { data: Uint8Array; dim: number } {
  let bits = "";
  for (const c of QR_HEX) bits += parseInt(c, 16).toString(2).padStart(4, "0");
  const dim = (QR_SIZE + quiet * 2) * scale;
  const data = new Uint8Array(dim * dim * 4).fill(255);
  for (let y = 0; y < QR_SIZE; y++) {
    for (let x = 0; x < QR_SIZE; x++) {
      if (bits[y * QR_SIZE + x] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

function qrPngBytes(): Uint8Array {
  const { data, dim } = qrRgba();
  return encodePng({ width: dim, height: dim, data, channels: 4 });
}

function qrJpegBytes(): Uint8Array {
  const { data, dim } = qrRgba();
  return new Uint8Array(encodeJpeg({ width: dim, height: dim, data }, 90).data);
}

describe("qr-code (F-04)", () => {
  it("errors when a PNG texture contains a decodable QR code", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: qrPngBytes(), name: "sneaky" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].where ?? "", /model\.glb/);
    assert.match(findings[0].where ?? "", /sneaky/);
    assert.equal(findings[0].data?.decoded, "https://example.com/qr");
  });

  it("errors when a JPEG texture contains a decodable QR code", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: qrJpegBytes(), mimeType: "image/jpeg", name: "jq" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
  });

  it("errors when the thumbnail contains a QR code", async () => {
    const result = await validate(await syntheticZip({ thumbnail: qrPngBytes() }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "thumbnail.png");
  });

  it("passes a clean wearable zip", async () => {
    const glb = await syntheticGlb({ texture: { size: 64 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    assert.equal(result.findings.filter((f) => f.check === "qr-code").length, 0);
    assert.equal(result.checks.find((c) => c.check === "qr-code")?.status, "passed");
  });
});
