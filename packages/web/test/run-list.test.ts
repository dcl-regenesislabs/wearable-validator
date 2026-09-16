import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runChip } from "../src/run-list.js";

const run = (done: boolean, passed: boolean | null) => ({ id: "r", name: "item.zip", startedAt: 0, done, passed });

describe("your runs chip", () => {
  it("shows a failure only for a failing verdict", () => {
    assert.deepEqual(runChip(run(false, null)), { status: "skipped", label: "Running" });
    assert.deepEqual(runChip(run(true, true)), { status: "passed", label: "Passed" });
    assert.deepEqual(runChip(run(true, false)), { status: "failed", label: "Needs attention" });
    assert.deepEqual(runChip(run(true, null)), { status: "skipped", label: "No verdict" });
  });
});
