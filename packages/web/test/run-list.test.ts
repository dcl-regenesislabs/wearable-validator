import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { historyRow, isModifiedClick, routeFrom, routeUrl, runChip, runIdFrom, runLoadMessage, runUrl, tabFrom, waitText } from "../src/run-list.js";
import { captionFor } from "../src/run-view.js";

const run = (done: boolean, passed: boolean | null) => ({ id: "r", name: "item.zip", startedAt: 0, done, passed });

describe("in-app links", () => {
  const click = (patch: Partial<Parameters<typeof isModifiedClick>[0]> = {}) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, ...patch });
  it("route plain clicks in place and leave modified ones to the browser", () => {
    assert.equal(isModifiedClick(click()), false);
    assert.equal(isModifiedClick(click({ metaKey: true })), true);
    assert.equal(isModifiedClick(click({ ctrlKey: true })), true);
    assert.equal(isModifiedClick(click({ shiftKey: true })), true);
    assert.equal(isModifiedClick(click({ altKey: true })), true);
    assert.equal(isModifiedClick(click({ button: 1 })), true);
  });
});

describe("history chip", () => {
  it("shows a failure only for a failing verdict", () => {
    assert.deepEqual(runChip(run(false, null)), { status: "skipped", label: "Running" });
    assert.deepEqual(runChip({ ...run(false, null), queued: true }), { status: "skipped", label: "Waiting" });
    assert.deepEqual(runChip(run(true, true)), { status: "passed", label: "Passed" });
    assert.deepEqual(runChip(run(true, false)), { status: "failed", label: "Needs attention" });
    assert.deepEqual(runChip(run(true, null)), { status: "skipped", label: "No verdict" });
  });
});

describe("history row", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  it("names the sender only when the server did", () => {
    const own = historyRow({ ...run(true, true), startedAt: now - 3 * 60_000 }, now);
    assert.equal(own.sentBy, undefined);
    assert.equal("sentBy" in own, false);
    assert.equal(own.when, "3 minutes ago");
    assert.equal(own.live, false);
    const theirs = historyRow({ ...run(false, null), owner: "ana@example.test", startedAt: now - 20_000 }, now);
    assert.equal(theirs.sentBy, "ana@example.test");
    assert.equal(theirs.when, "now");
    assert.equal(theirs.live, true);
    assert.deepEqual(theirs.chip, { status: "skipped", label: "Running" });
  });
  it("says 'earlier' when the start time is unknown", () => {
    assert.equal(historyRow(run(true, null), now).when, "earlier");
  });
});

describe("wait text", () => {
  it("rounds the estimate to minutes", () => {
    assert.equal(waitText(null), "");
    assert.equal(waitText(30_000), "under a minute");
    assert.equal(waitText(150_000), "about 3 min");
  });
});

describe("tabs and routes", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("opens Validate by default and History for ?tab=history or any ?run=", () => {
    assert.equal(tabFrom(""), "validate");
    assert.equal(tabFrom("?urn=urn:decentraland:x"), "validate");
    assert.equal(tabFrom("?tab=history"), "history");
    assert.equal(tabFrom(`?run=${id}`), "history");
    assert.equal(tabFrom("?tab=other"), "validate");
  });

  it("reads and writes the whole route", () => {
    assert.deepEqual(routeFrom(""), { tab: "validate", run: null, urn: null });
    assert.deepEqual(routeFrom("?urn=urn:decentraland:x&tab=history"), { tab: "history", run: null, urn: "urn:decentraland:x" });
    assert.equal(routeUrl({ tab: "validate", run: null, urn: null }), "/");
    assert.equal(routeUrl({ tab: "history", run: null, urn: null }), "/?tab=history");
    assert.equal(routeUrl({ tab: "history", run: id, urn: null }), `/?run=${id}`);
    assert.equal(routeUrl({ tab: "validate", run: null, urn: "urn:decentraland:x" }), "/?urn=urn%3Adecentraland%3Ax");
    for (const route of [{ tab: "history" as const, run: id, urn: "urn:decentraland:x" }, { tab: "history" as const, run: null, urn: null }]) {
      assert.deepEqual(routeFrom(new URL(routeUrl(route), "https://example.test").search), route);
    }
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

describe("capture captions", () => {
  it("names the green skin of a motion-pass frame so the colour reads as intended", () => {
    const request = { id: "x", key: "x", inputDigest: "d", rendererBuild: "b", recipeVersion: 1, bodyShape: "urn:decentraland:off-chain:base-avatars:BaseMale", mainFile: "m.glb", view: "avatar" as const, azimuthDegrees: 0, size: 512 };
    assert.equal(captionFor({ id: "x", request, sha256: "s", url: "/x" }), "BaseMale · avatar · 0°");
    assert.equal(captionFor({ id: "y", request: { ...request, pose: "dab", timeFraction: 0.5, skin: "00ff00" }, sha256: "s", url: "/y" }), "BaseMale · avatar · dab · 0° · t=0.5 · green skin");
  });
});
