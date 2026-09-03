import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/registry.js";
import { explanations } from "../src/explanations.js";

describe("plain-language explanations", () => {
  it("every check has one, written in plain words", () => {
    for (const check of registry) {
      const text = explanations[check.name];
      assert.ok(text, `missing explanation for ${check.name}`);
      assert.ok(text.length > 30, `${check.name} explanation too short to explain anything`);
    }
  });
  it("no explanation for a check that doesn't exist", () => {
    const names = new Set(registry.map((c) => c.name));
    for (const key of Object.keys(explanations)) {
      assert.ok(names.has(key), `explanation for unknown check "${key}"`);
    }
  });
});
