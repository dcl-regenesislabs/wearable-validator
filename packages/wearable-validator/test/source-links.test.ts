import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/registry.js";
import { sourceLinks } from "../src/source-links.js";
import { scanSourceLinks } from "../generate-source-links.js";
import sourceLinksJson from "../src/source-links.json" with { type: "json" };

describe("source links", () => {
  it("every check links to its implementation", () => {
    for (const check of registry) {
      assert.ok(sourceLinks[check.name], `missing source link for ${check.name}`);
    }
  });
  it("the committed map matches the code (run npm run gen:sources after moving checks)", async () => {
    assert.deepEqual(sourceLinksJson, await scanSourceLinks());
  });
});
