import assert from "node:assert/strict";
import { test } from "node:test";
import { Wearable, Emote } from "@dcl/schemas";
import { validate } from "../src/index.js";
import { syntheticGlb, syntheticZip } from "./helpers/synthetic.js";

function item(kind: "wearable" | "emote") {
  const data = {
    category: kind === "wearable" ? "hat" : "fun", tags: [],
    representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"], overrideHides: [], overrideReplaces: [] }]
  };
  return {
    id: "urn:decentraland:matic:collections-v2:0xae473ded66fd0b2b99039f7d0ddd8e66beb485b8:0",
    name: "Test", description: "Test item", rarity: "common",
    collectionAddress: "0xae473ded66fd0b2b99039f7d0ddd8e66beb485b8",
    i18n: [{ code: "en", text: "Test" }], thumbnail: "thumbnail.png", image: "image.png",
    ...(kind === "wearable" ? { data: { ...data, hides: [], replaces: [] } } : { emoteDataADR74: { ...data, loop: false } })
  };
}

for (const kind of ["wearable", "emote"] as const) {
  test(`S-03 accepts complete ${kind} metadata using the official schema`, async () => {
    const metadata = item(kind);
    const official = kind === "wearable" ? Wearable.validate : Emote.validate;
    assert.equal(official(metadata), true, JSON.stringify(official.errors));
    const result = await validate({ files: new Map(), metadata }, { checks: ["metadata"] });
    assert.deepEqual(result.findings, []);
  });

  test(`S-03 reports multiple ${kind} fields and duplicate locales`, async () => {
    const metadata = { ...item(kind), description: 42, thumbnail: false, i18n: [{ code: "en", text: "One" }, { code: "en", text: "Two" }] };
    const result = await validate({ files: new Map(), metadata }, { checks: ["metadata"] });
    for (const field of ["description", "thumbnail", "i18n"]) assert.ok(result.findings.some(f => f.where === field), field);
    assert.equal(result.checks[0].status, "failed");
    assert.ok(!result.findings.some(f => f.where === "merkleProof"));
  });
}

for (const metadata of [null, false, "bad", { id: 42 }, { ...item("wearable"), data: { category: [], representations: [null, { mainFile: 42, bodyShapes: null, contents: false }] } }, { ...item("emote"), emoteDataADR74: null }]) {
  test(`S-03 reports malformed metadata without crashing: ${JSON.stringify(metadata)}`, async () => {
    const result = await validate({ files: new Map([["model.glb", await syntheticGlb()]]), metadata });
    assert.equal(result.checks.find(c => c.check === "metadata")?.status, "failed");
    assert.ok(!result.checks.some(c => c.status === "errored"), JSON.stringify(result.findings));
    assert.ok(result.checks.some(c => c.check === "file-format"));
  });
}

test("Builder and bare GLB modes do not require entity schema fields", async () => {
  const builder = await validate(await syntheticZip(), { checks: ["metadata"] });
  assert.deepEqual(builder.findings, []);
  const bare = await validate(await syntheticGlb(), { checks: ["metadata"] });
  assert.equal(bare.passed, null);
  assert.ok(!bare.findings.some(f => f.check === "metadata"));
});

test("S-03 reports missing schema fields with their paths", async () => {
  const { i18n, ...metadata } = item("wearable");
  const result = await validate({ files: new Map(), metadata }, { checks: ["metadata"] });
  assert.ok(result.findings.some(f => f.where === "i18n" && f.measured === "Missing"));
});
