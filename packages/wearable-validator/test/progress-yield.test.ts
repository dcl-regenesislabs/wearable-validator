import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/registry.js";
import { validate } from "../src/validate.js";
import type { CheckDefinition } from "../src/types.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";

/** Two probe checks at the end of the content group: the first arms a timer, the second reports whether it fired in between. */
function probes(): { checks: CheckDefinition[]; fired: () => boolean | undefined } {
  let armed = false;
  let seen: boolean | undefined;
  const meta = { group: "content" as const, docs: "https://example.test", title: "probe", describe: "probe", explanation: "probe", fix: "probe", details: "probe" };
  const checks: CheckDefinition[] = [
    { ...meta, name: "yield-probe-a", rule: "T-98", run: () => { setTimeout(() => (armed = true), 0); return []; } },
    { ...meta, name: "yield-probe-b", rule: "T-99", run: () => { seen = armed; return []; } }
  ];
  return { checks, fired: () => seen };
}

async function runWithProbes(onProgress?: () => void): Promise<boolean | undefined> {
  const { checks, fired } = probes();
  registry.push(...checks);
  try {
    await validate(await syntheticGlb(), { groups: ["content"], ...(onProgress ? { onProgress } : {}) });
  } finally {
    registry.splice(registry.length - checks.length, checks.length);
  }
  return fired();
}

describe("validate() and the event loop", () => {
  it("yields after each check when onProgress is given, so a browser can paint between checks", async () => {
    assert.equal(await runWithProbes(() => {}), true);
  });

  it("adds no yield without onProgress", async () => {
    assert.equal(await runWithProbes(), false);
  });
});
