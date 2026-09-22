import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runChip, runIdFrom, runLoadMessage, runUrl } from "../src/run-list.js";

const run = (done: boolean, passed: boolean | null) => ({ id: "r", name: "item.zip", startedAt: 0, done, passed });

describe("your runs chip", () => {
  it("shows a failure only for a failing verdict", () => {
    assert.deepEqual(runChip(run(false, null)), { status: "skipped", label: "Running" });
    assert.deepEqual(runChip({ ...run(false, null), queued: true }), { status: "skipped", label: "Waiting" });
    assert.deepEqual(runChip(run(true, true)), { status: "passed", label: "Passed" });
    assert.deepEqual(runChip(run(true, false)), { status: "failed", label: "Needs attention" });
    assert.deepEqual(runChip(run(true, null)), { status: "skipped", label: "No verdict" });
  });
});

describe("run deep link", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("reads the run id from the query", () => {
    assert.equal(runIdFrom(`?run=${id}`), id);
    assert.equal(runIdFrom(`?urn=urn:decentraland:x&run=${id}`), id);
    assert.equal(runIdFrom(`?run=%20${id}%20`), id);
  });

  it("names no run without the parameter or with one that cannot go in a path", () => {
    assert.equal(runIdFrom(""), null);
    assert.equal(runIdFrom("?urn=urn:decentraland:x"), null);
    assert.equal(runIdFrom("?run="), null);
    assert.equal(runIdFrom("?run=../other"), null);
    assert.equal(runIdFrom("?run=a%2Fb"), null);
    assert.equal(runIdFrom(`?run=${"a".repeat(65)}`), null);
  });

  it("round-trips through the shareable URL", () => {
    assert.equal(runUrl(id), `/?run=${id}`);
    assert.equal(runIdFrom(new URL(runUrl(id), "https://example.test").search), id);
  });

  it("explains why a run did not open", () => {
    assert.equal(runLoadMessage(404), "This run does not exist or belongs to another curator.");
    assert.equal(runLoadMessage(401), "Sign in to open this run.");
    assert.match(runLoadMessage(null), /not reachable/);
    assert.match(runLoadMessage(503), /503/);
  });
});
