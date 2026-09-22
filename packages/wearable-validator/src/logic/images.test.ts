import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decode as decodePng } from "fast-png";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { manifest } from "../manifest/index.js";
import { decodePngSafe, imageDimensions, jpegPrecision, pngHasAlpha } from "./images.js";
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

  it("reads a header whose file has trailing bytes or is cut short after the header", () => {
    const trailing = new Uint8Array(pngBytes(8, 8).length + 1);
    trailing.set(pngBytes(8, 8));
    assert.deepEqual(imageDimensions(trailing), { width: 8, height: 8 });
    assert.deepEqual(imageDimensions(pngBytes(8, 8).subarray(0, 33)), { width: 8, height: 8 });
    assert.equal(decodePngSafe(trailing), undefined, "decoding still needs a whole, well-formed file");
  });

  it("answers undefined for a header it cannot read, never a size", () => {
    assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), undefined);
    const noHeader = new Uint8Array(40);
    noHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    noHeader.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 8);
    assert.equal(imageDimensions(noHeader), undefined);
  });
});

describe("pngHasAlpha", () => {
  it("reads the color type from IHDR wherever it sits, not from a fixed offset", () => {
    const rgba = pngBytes(2, 2);
    assert.equal(pngHasAlpha(rgba), true);
    assert.equal(pngHasAlpha(pngWithLeadingChunk(rgba)), true);
    const rgb = pngHeaderBytes(2, 2);
    rgb[25] = 2;
    assert.equal(pngHasAlpha(rgb), false);
    assert.equal(pngHasAlpha(new Uint8Array([1, 2, 3])), false);
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
