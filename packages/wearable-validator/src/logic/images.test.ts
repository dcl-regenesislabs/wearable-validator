import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decode as decodePng } from "fast-png";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { manifest } from "../manifest/index.js";
import { decodePngSafe, fitsDecodeBudget, imageDimensions, jpegPrecision } from "./images.js";
import { jpegWithFillBytes, pngBytes, pngHeaderBytes, pngWithLeadingChunk } from "#test/helpers/synthetic.js";

const jpeg = (size: number): Uint8Array => new Uint8Array(encodeJpeg({ width: size, height: size, data: new Uint8Array(size * size * 4).fill(128) }, 80).data);

describe("imageDimensions", () => {
  it("reads the claimed dimensions from the header without decoding", () => {
    const bomb = pngHeaderBytes(12000, 12000);
    assert.deepEqual(imageDimensions(bomb), { width: 12000, height: 12000 });
    assert.ok(12000 * 12000 > manifest.images.maxDecodePixels);
  });

  it("finds IHDR behind a leading chunk, as fast-png does", () => {
    const crafted = pngWithLeadingChunk(pngBytes(8, 8));
    assert.equal(decodePng(crafted).width, 8, "the decoder accepts the crafted file");
    assert.deepEqual(imageDimensions(crafted), { width: 8, height: 8 });
    assert.deepEqual(imageDimensions(pngWithLeadingChunk(pngHeaderBytes(12000, 12000))), { width: 12000, height: 12000 });
  });

  it("walks past JPEG fill bytes, as jpeg-js does", () => {
    const crafted = jpegWithFillBytes(jpeg(8));
    assert.equal(decodeJpeg(crafted).width, 8, "the decoder accepts the crafted file");
    assert.deepEqual(imageDimensions(crafted), { width: 8, height: 8 });
    assert.equal(jpegPrecision(crafted), 8);
  });

  it("answers undefined for a header it cannot read, never a size", () => {
    assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), undefined);
    const noHeader = new Uint8Array(40);
    noHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    noHeader.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 8);
    assert.equal(imageDimensions(noHeader), undefined);
  });
});

describe("fitsDecodeBudget", () => {
  it("lets images within the budget through and honours a custom budget", () => {
    const small = pngBytes(16, 16);
    assert.equal(fitsDecodeBudget(small), true);
    assert.equal(fitsDecodeBudget(small, 100), false);
    assert.equal(fitsDecodeBudget(pngHeaderBytes(12000, 12000)), false);
  });

  it("refuses an unreadable header instead of trusting the decoder", () => {
    assert.equal(fitsDecodeBudget(new Uint8Array([1, 2, 3])), false);
  });
});

describe("decodePngSafe", () => {
  it("refuses a header above the pixel budget instead of inflating it, wherever IHDR sits", () => {
    assert.equal(decodePngSafe(pngHeaderBytes(12000, 12000)), undefined);
    assert.equal(decodePngSafe(pngWithLeadingChunk(pngHeaderBytes(12000, 12000))), undefined);
    assert.equal(decodePngSafe(pngBytes(8, 8))?.width, 8);
    assert.equal(decodePngSafe(pngWithLeadingChunk(pngBytes(8, 8)))?.width, 8);
  });
});
