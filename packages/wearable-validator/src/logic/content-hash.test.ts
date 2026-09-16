import assert from "node:assert/strict";
import { test } from "node:test";
import { hashVectors } from "#test/helpers/hash-vectors.js";
import { validate } from "../validate.js";
import { contentHash } from "./content-hash.js";

for (const { size, legacy, cidV1 } of hashVectors) {
  test(`browser-compatible content hash matches Decentraland for ${size} bytes`, async () => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    assert.equal(await contentHash(bytes), cidV1);
    assert.equal(await contentHash(bytes, 0), legacy);
  });
}

test("content integrity accepts mixed legacy and CIDv1 declarations and rejects altered bytes", async () => {
  const original = new TextEncoder().encode("hello world\n");
  const files = new Map([["legacy.txt", original], ["current.txt", original]]);
  const content = [
    { file: "legacy.txt", hash: "QmZjTnYw2TFhn9Nn7tjmPSoTBoY7YRkwPzwSrSbabY24Kp" },
    { file: "current.txt", hash: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4" }
  ];
  const options = { checks: ["content-integrity"] };
  const matching = await validate({ files, content }, options);
  assert.equal(matching.checks[0]?.status, "passed");
  assert.equal(matching.findings.length, 0);
  files.set("legacy.txt", new TextEncoder().encode("altered"));
  const altered = await validate({ files, content }, options);
  assert.equal(altered.checks[0]?.status, "failed");
  assert.equal(altered.findings.length, 1);
  assert.equal(altered.findings[0]?.where, "legacy.txt");
  assert.equal(altered.findings[0]?.limit, content[0].hash);
});
