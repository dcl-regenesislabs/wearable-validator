import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { urnFrom, urnUrl } from "../src/route.js";

describe("route", () => {
  const urn = "urn:decentraland:matic:collections-v2:0x0000000000000000000000000000000000000001:0";

  it("reads the catalyst item from ?urn= and round-trips it", () => {
    assert.equal(urnFrom(""), null);
    assert.equal(urnFrom("?urn=%20"), null);
    assert.equal(urnFrom(urnUrl(urn).slice(1)), urn);
    assert.equal(urnUrl(null), "/");
  });

  it("ignores the old History links", () => {
    assert.equal(urnFrom("?tab=history"), null);
    assert.equal(urnFrom("?run=abc"), null);
  });
});
