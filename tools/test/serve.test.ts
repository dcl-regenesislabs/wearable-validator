import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { digest } from "../../packages/wearable-validator/src/logic/captures.js";
import { manifest } from "../../packages/wearable-validator/src/manifest/index.js";
import type { CaptureRecord, Renderer, Reviewer } from "../../packages/wearable-validator/src/types.js";
import { pngBytes, syntheticGlb, syntheticZip } from "../../packages/wearable-validator/test/helpers/synthetic.js";
import { createRunServer, liveReviewer, type RunSink } from "../src/serve.js";
import { recordingReviewer } from "../src/visual-review.js";

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

const body = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Reads one SSE stream to its end and returns the parsed frames. */
async function readEvents(url: string): Promise<Frame[]> {
  const text = await (await fetch(url)).text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const type = /event: (.*)/.exec(block)![1];
      const data = /data: (.*)/.exec(block)![1];
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });
}

function fakeServices(calls: { services: number }) {
  return async (run: RunSink) => {
    calls.services++;
    const size = manifest.rendering.imageSizePx;
    const bytes = pngBytes(size, size);
    const renderer: Renderer = {
      buildId: "fake-build",
      capture: async (_input, requests) => {
        const captures: CaptureRecord[] = [];
        for (const request of requests) {
          const capture = { request, bytes, sha256: await digest(bytes), width: size, height: size };
          await run.capture(capture);
          captures.push(capture);
        }
        return captures;
      },
      stop: async () => {}
    };
    const base: Reviewer = {
      review: async (request) => ({
        ok: true,
        answer: { verdict: "matches", summary: "Same shirt.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
        metadata: { provider: "fake", model: "fixture", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
      })
    };
    // the same wrapping main() does: record the prompt/answer on disk, then announce them
    return { renderer, reviewer: liveReviewer(recordingReviewer(base, run.dir, "thumbnail-honesty"), run, "thumbnail-honesty") };
  };
}

describe("run server", () => {
  let out: string;
  let base: string;
  let close: () => Promise<void>;
  const calls = { services: 0 };

  before(async () => {
    out = await mkdtemp(join(tmpdir(), "run-server-"));
    const created = createRunServer({ out, services: fakeServices(calls), capabilities: { renderer: true, reviewer: "dry-run" } });
    close = created.close;
    await new Promise<void>((resolve) => created.server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await close();
    await rm(out, { recursive: true, force: true });
  });

  it("reports its capabilities", async () => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as { visual: { renderer: boolean }; checks: string[] };
    assert.equal(health.visual.renderer, true);
    assert.deepEqual(health.checks, ["thumbnail-honesty"]);
  });

  it("stops at the code gate without building any adapter when the item fails code checks", async () => {
    const zip = await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) });
    const started = (await (await fetch(`${base}/api/runs`, { method: "POST", body: body(zip), headers: { "x-file-name": "bad.zip" } })).json()) as { id: string };
    const events = await readEvents(`${base}/api/runs/${started.id}/events`);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("gate"));
    assert.equal(types.at(-1), "done");
    assert.equal((events.at(-1)!.data as { skipped?: boolean }).skipped, true);
    assert.equal(calls.services, 0);
    assert.ok(types.filter((t) => t === "check").length > 10, "the code checks stream too");
  });

  it("streams every capture, the prompt and the answer, and serves the images", async () => {
    const zip = await syntheticZip();
    const started = (await (await fetch(`${base}/api/runs?standalone=1`, { method: "POST", body: body(zip), headers: { "x-file-name": "shirt.zip" } })).json()) as { id: string };
    const events = await readEvents(`${base}/api/runs/${started.id}/events`);
    const captures = events.filter((e) => e.type === "capture");
    assert.equal(captures.length, 12);
    assert.equal(captures[0].data.id, "BaseMale-avatar-000");
    const reviews = events.filter((e) => e.type === "review").map((e) => e.data.phase);
    assert.deepEqual(reviews, ["request", "answer"]);
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    const result = done.data.result as { checks: { check: string; status: string }[]; captures: { url: string }[] };
    assert.equal(result.checks[0].status, "passed");
    assert.equal(result.captures.length, 12);
    const image = await fetch(`${base}${captures[3].data.url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(new Uint8Array(await image.arrayBuffer())[1], 0x50);
    const prompt = await fetch(`${base}/api/runs/${started.id}/thumbnail-honesty/1-prompt.md`);
    assert.equal(prompt.status, 200);
    assert.match(await prompt.text(), /Image ID: BaseMale-avatar-000/);
    assert.equal(calls.services, 1);
  });

  it("replays a finished run after Last-Event-ID and refuses paths outside the run folder", async () => {
    const zip = await syntheticZip();
    const started = (await (await fetch(`${base}/api/runs?standalone=1`, { method: "POST", body: body(zip) })).json()) as { id: string };
    const all = await readEvents(`${base}/api/runs/${started.id}/events`);
    const later = await (await fetch(`${base}/api/runs/${started.id}/events`, { headers: { "last-event-id": String(all.length - 2) } })).text();
    assert.equal(later.split("\n\n").filter((block) => block.includes("event:")).length, 2);
    assert.equal((await fetch(`${base}/api/runs/${started.id}/captures/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/nope/events`)).status, 404);
  });
});
