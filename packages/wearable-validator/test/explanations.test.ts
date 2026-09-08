import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/registry.js";
import { explanations } from "../src/explanations.js";
import { fixes } from "../src/fixes.js";
import { details } from "../src/details.js";

describe("plain-language explanations", () => {
  it("every check has one, written in plain words", () => {
    for (const check of registry) {
      const text = explanations[check.name];
      assert.ok(text, `missing explanation for ${check.name}`);
      assert.ok(text.length > 30, `${check.name} explanation too short to explain anything`);
    }
  });
  it("every check has concrete fix guidance", () => {
    for (const check of registry) {
      const text = fixes[check.name];
      assert.ok(text, `missing fix for ${check.name}`);
      assert.ok(text.length > 40, `${check.name} fix too short to be actionable`);
    }
  });
  it("every check documents how it checks", () => {
    for (const check of registry) {
      assert.ok(details[check.name], `missing details for ${check.name}`);
    }
  });
  it("no explanation for a check that doesn't exist", () => {
    const names = new Set(registry.map((c) => c.name));
    for (const key of Object.keys(explanations)) {
      assert.ok(names.has(key), `explanation for unknown check "${key}"`);
    }
  });
});
