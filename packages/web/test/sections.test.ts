import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NONE_COLLAPSED, allCollapsed, collapseAll, expandAll, toggleSection } from "../src/sections.js";

describe("collapsible sections", () => {
  const keys = ["files", "model", "visual", "rendering"];

  it("start open and toggle one at a time without touching the others", () => {
    assert.equal(NONE_COLLAPSED.size, 0);
    const one = toggleSection(NONE_COLLAPSED, "model");
    assert.deepEqual([...one], ["model"]);
    assert.deepEqual([...toggleSection(one, "visual")].sort(), ["model", "visual"]);
    assert.equal(toggleSection(one, "model").size, 0);
    assert.equal(NONE_COLLAPSED.size, 0, "the shared empty set is never mutated");
  });

  it("collapse and expand all the listed sections at once", () => {
    const all = collapseAll(keys);
    assert.deepEqual([...all], keys);
    assert.equal(allCollapsed(all, keys), true);
    assert.equal(allCollapsed(toggleSection(all, "files"), keys), false);
    assert.equal(expandAll().size, 0);
    assert.equal(allCollapsed(expandAll(), keys), false);
    assert.equal(allCollapsed(NONE_COLLAPSED, []), false, "nothing to collapse reads as Collapse all, never Expand all");
  });
});
