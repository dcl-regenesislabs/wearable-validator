import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureRequest, digest, digestJson, rendererBuild, resolveCaptures, validCapture } from "../src/captures.js";
import { manifest } from "../src/manifest/index.js";
import type { CaptureRecord, CaptureRequest, CheckContext, Renderer } from "../src/types.js";
import { pngBytes } from "./helpers/synthetic.js";

const SIZE = 16;
const [MALE, FEMALE] = manifest.rendering.bodyShapes;

/** A minimal context — captures.ts reads files, item, itemType, category, manifest, captures, services, signal. */
function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    files: new Map([["model.glb", new Uint8Array([1, 2, 3])]]),
    item: { category: "hat", representations: [{ bodyShapes: [MALE], mainFile: "model.glb", contents: ["model.glb"] }] },
    itemType: "wearable",
    category: "hat",
    metadataMode: "builder",
    inputKind: "zip",
    totalBytes: 3,
    models: [],
    manifest,
    emptyFiles: [],
    captures: [],
    ...overrides
  };
}

function request(ctx: CheckContext, fields: Partial<CaptureRequest> = {}): Promise<CaptureRequest> {
  return captureRequest(ctx, {
    inputDigest: "input",
    rendererBuild: "build-a",
    recipeVersion: 1,
    bodyShape: MALE,
    mainFile: "model.glb",
    view: "avatar",
    azimuthDegrees: 0,
    size: SIZE,
    ...fields
  });
}

async function record(req: CaptureRequest, bytes = pngBytes(req.size, req.size)): Promise<CaptureRecord> {
  return { request: req, bytes, sha256: await digest(bytes), width: req.size, height: req.size };
}

function fakeRenderer(buildId: string, rendered: CaptureRequest[][], drop = 0): Renderer {
  return {
    buildId,
    capture: async (_input, requests) => {
      rendered.push(requests);
      return Promise.all(requests.slice(0, requests.length - drop).map((req) => record(req)));
    },
    stop: async () => {}
  };
}

describe("captures", () => {
  it("digestJson ignores key order at every depth and distinguishes values", async () => {
    const a = await digestJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } });
    const b = await digestJson({ a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 });
    assert.equal(a, b);
    assert.notEqual(a, await digestJson({ a: { c: "x", d: [{ y: 2, z: 1 }, 1] }, b: 1 }));
  });

  it("captureRequest fills the human id and a key that names the scene", async () => {
    const ctx = context();
    const front = await request(ctx);
    assert.equal(front.id, "BaseMale-avatar-000");
    assert.equal((await request(ctx, { bodyShape: FEMALE, view: "wearable", azimuthDegrees: 90, timeFraction: 0.5 })).id, "BaseFemale-wearable-090-t0.5");
    assert.equal(front.key, (await request(ctx)).key);
    assert.notEqual(front.key, (await request(ctx, { azimuthDegrees: 90 })).key);
    const scene = { ...manifest.rendering, background: "000000" };
    assert.notEqual(front.key, (await request(context({ manifest: { ...manifest, rendering: scene } }))).key);
  });

  it("validCapture rejects the wrong size, sha, format or request", async () => {
    const ctx = context();
    const req = await request(ctx);
    const max = manifest.rendering.maxCaptureBytes;
    assert.equal(await validCapture(await record(req), req, max), true);
    assert.equal(await validCapture(await record(req, pngBytes(SIZE, SIZE + 1)), req, max), false);
    assert.equal(await validCapture({ ...(await record(req)), sha256: "0".repeat(64) }, req, max), false);
    assert.equal(await validCapture(await record(req, new TextEncoder().encode("not a png at all, really")), req, max), false);
    assert.equal(await validCapture(await record(req), await request(ctx, { azimuthDegrees: 90 }), max), false);
    assert.equal(await validCapture(await record(req), req, 8), false);
  });

  it("rendererBuild prefers the renderer, else the one shared supplied build, else undefined", async () => {
    const ctx = context();
    const a = await record(await request(ctx, { rendererBuild: "build-a" }));
    const b = await record(await request(ctx, { rendererBuild: "build-b" }));
    assert.equal(rendererBuild(context({ captures: [] })), undefined);
    assert.equal(rendererBuild(context({ captures: [a, a] })), "build-a");
    assert.equal(rendererBuild(context({ captures: [a, b] })), undefined);
    assert.equal(rendererBuild(context({ captures: [a, b], services: { renderer: fakeRenderer("build-c", []) } })), "build-c");
  });

  it("resolveCaptures returns a reason without a renderer and renders only the missing keys", async () => {
    const ctx = context();
    const front = await request(ctx);
    const side = await request(ctx, { azimuthDegrees: 90 });
    const supplied = await record(front);
    ctx.captures = [supplied];
    assert.equal(await resolveCaptures(ctx, [front, side]), "Supply 1 missing or stale rendered views, or configure services.renderer to capture them.");
    const rendered: CaptureRequest[][] = [];
    ctx.services = { renderer: fakeRenderer("build-a", rendered) };
    const captures = await resolveCaptures(ctx, [front, side]);
    assert.ok(Array.isArray(captures));
    assert.deepEqual(rendered.map((batch) => batch.map((req) => req.id)), [["BaseMale-avatar-090"]]);
    assert.equal(captures[0], supplied);
    assert.equal(captures[1].request.id, "BaseMale-avatar-090");
    assert.deepEqual(ctx.captures.map((capture) => capture.request.id), ["BaseMale-avatar-000", "BaseMale-avatar-090"]);
  });

  it("resolveCaptures keeps other rules' captures and drops stale ones from the result", async () => {
    const ctx = context();
    const front = await request(ctx);
    const stale = await record(front, pngBytes(SIZE + 1, SIZE + 1));
    const other = await record(await request(ctx, { view: "wearable" }));
    ctx.captures = [stale, other];
    ctx.services = { renderer: fakeRenderer("build-a", []) };
    const captures = await resolveCaptures(ctx, [front]);
    assert.ok(Array.isArray(captures));
    assert.notEqual(captures[0], stale);
    assert.deepEqual(ctx.captures.map((capture) => capture.request.id), ["BaseMale-avatar-000", "BaseMale-wearable-000"]);
  });

  it("resolveCaptures rejects a renderer that returns fewer or invalid views", async () => {
    const ctx = context({ services: { renderer: fakeRenderer("build-a", [], 1) } });
    const requests = [await request(ctx), await request(ctx, { azimuthDegrees: 90 })];
    await assert.rejects(resolveCaptures(ctx, requests), /did not return a valid BaseMale-avatar-090 view/);
    ctx.captures = [];
    ctx.services = {
      renderer: {
        buildId: "build-a",
        capture: async (_input, batch) => Promise.all(batch.map((req) => record({ ...req, size: SIZE + 1 }))),
        stop: async () => {}
      }
    };
    await assert.rejects(resolveCaptures(ctx, requests), /did not return a valid BaseMale-avatar-000 view/);
  });

  it("resolveCaptures honours an aborted signal before rendering", async () => {
    const rendered: CaptureRequest[][] = [];
    const ctx = context({ services: { renderer: fakeRenderer("build-a", rendered) }, signal: AbortSignal.abort() });
    await assert.rejects(resolveCaptures(ctx, [await request(ctx)]), /abort/i);
    assert.deepEqual(rendered, []);
  });
});
