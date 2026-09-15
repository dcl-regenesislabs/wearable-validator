import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/index.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("plumbing smoke", () => {
  it("runs on a synthetic wearable zip and returns a result", async () => {
    const zip = await syntheticZip();
    const result = await validate(zip);
    assert.equal(typeof result.summary.checked, "number");
    assert.ok(Array.isArray(result.findings));
  });

  it("bare GLB never mints a verdict", async () => {
    const glb = await syntheticGlb();
    const result = await validate(glb);
    assert.equal(result.passed, null);
  });

  it("bad bytes yield a file-format finding, never a throw", async () => {
    const result = await validate(new Uint8Array([1, 2, 3, 4, 5]));
    assert.equal(result.passed, false);
    assert.equal(result.findings[0].check, "file-format");
  });

  it("unknown check name throws (programmer error)", async () => {
    await assert.rejects(() => validate(new Uint8Array([1]), { checks: ["nope"] }), /Unknown check/);
  });
});

describe("progress events", () => {
  it("reports every check starting and finishing, in registry order, without changing the result", async () => {
    const events: string[] = [];
    const result = await validate(await syntheticZip(), {
      onProgress: (event) => events.push(event.type === "check-started" ? `>${event.check}` : `<${event.result.check}:${event.result.status}`)
    });
    const names = result.checks.map((row) => row.check);
    assert.deepEqual(events.filter((e) => e.startsWith(">")).map((e) => e.slice(1)), names);
    assert.deepEqual(events.filter((e) => e.startsWith("<")).map((e) => e.slice(1)), result.checks.map((row) => `${row.check}:${row.status}`));
    for (let i = 0; i < names.length; i++) assert.equal(events.indexOf(`>${names[i]}`) < events.findIndex((e) => e.startsWith(`<${names[i]}:`)), true);
  });
});
