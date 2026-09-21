import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../validate.js";
import { digest } from "../../../logic/captures.js";
import { manifest } from "../../../manifest/index.js";
import type { Renderer, Reviewer, ReviewRequest, ReviewResult } from "../../../types.js";
import { emoteQualityPrompt, parseEmoteQualityAnswer } from "./index.js";
import { syntheticZip } from "#test/helpers/synthetic.js";
import { renderedFrame } from "#test/helpers/frames.js";

const CHECK = { checks: ["emote-quality"] };
const SIZE = manifest.rendering.imageSizePx;

function emoteZip(loop: boolean) {
  return syntheticZip({
    kind: "emote",
    manifest: {
      name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: loop ? "loop" : "simple",
      representations: [{ bodyShapes: manifest.rendering.bodyShapes, mainFile: "model.glb", contents: ["model.glb"] }]
    }
  });
}

function metadata(request: ReviewRequest): ReviewResult["metadata"] {
  return { provider: "test", model: "fixture", promptDigest: request.promptDigest, promptVersion: request.prompt.version };
}

function services(answer: (request: ReviewRequest) => ReviewResult) {
  const bytes = renderedFrame(SIZE);
  const rendered: number[] = [];
  const reviews: ReviewRequest[] = [];
  const renderer: Renderer = {
    buildId: "test-renderer",
    capture: async (_input, requests) => {
      rendered.push(requests.length);
      return Promise.all(requests.map(async (request) => ({ request, bytes, sha256: await digest(bytes), width: SIZE, height: SIZE })));
    },
    stop: async () => {}
  };
  const reviewer: Reviewer = { review: async (request) => (reviews.push(request), answer(request)) };
  return { renderer, reviewer, rendered, reviews };
}

const ok = (request: ReviewRequest): ReviewResult => ({
  ok: true,
  answer: { verdict: "ok", summary: "Looks intentional.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
  metadata: metadata(request)
});

describe("emote-quality (V-07)", () => {
  it("reviews the twenty timed frames and tells the model whether the emote loops", async () => {
    const mock = services(ok);
    const result = await validate(await emoteZip(true), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "passed");
    assert.deepEqual(mock.rendered, [20]);
    assert.equal(mock.reviews[0].images.length, 20);
    assert.equal(mock.reviews[0].images[0].id, "BaseMale-avatar-000-t0");
    assert.match(mock.reviews[0].images[0].label, /this emote loops/);
    const once = services(ok);
    await validate(await emoteZip(false), { ...CHECK, services: once });
    assert.match(once.reviews[0].images[0].label, /plays once and stops/);
  });

  it("reports defects as warnings with frame evidence", async () => {
    const mock = services((request) => ({
      ok: true,
      answer: {
        verdict: "issues",
        summary: "Feet float at the end.",
        reviewedCaptureIds: request.images.map((image) => image.id),
        findings: [{ aspect: "grounding", message: "Both feet hover above the floor at the end.", fix: "Pin the feet to the floor on the last keyframe.", captureIds: ["BaseMale-avatar-090-t1"] }]
      },
      metadata: metadata(request)
    }));
    const result = await validate(await emoteZip(false), { ...CHECK, services: mock });
    assert.equal(result.checks[0].status, "warning");
    assert.equal(result.findings[0].rule, "V-07");
    assert.equal(result.findings[0].data?.aspect, "grounding");
    assert.deepEqual(result.findings[0].evidence, [{ captureId: "BaseMale-avatar-090-t1" }]);
  });

  it("is not applicable to wearables", async () => {
    const result = await validate(await syntheticZip(), { ...CHECK, services: services(ok) });
    assert.equal(result.checks.length, 0);
  });

  it("rejects answers it cannot trust and pins its prompt version", () => {
    const ids = ["BaseMale-avatar-000-t0", "BaseMale-avatar-000-t0.5"];
    const limits = { maxFindings: manifest.emoteQuality.maxFindings, maxTextLength: manifest.ai.maxTextLength };
    const valid = { verdict: "ok", summary: "Fine.", reviewedCaptureIds: ids, findings: [] };
    assert.equal(typeof parseEmoteQualityAnswer(valid, ids, limits), "object");
    assert.equal(typeof parseEmoteQualityAnswer({ ...valid, verdict: "issues", findings: [{ aspect: "clipping", message: "x", fix: "y", captureIds: ids }] }, ids, limits), "string");
    assert.equal(typeof parseEmoteQualityAnswer({ ...valid, reviewedCaptureIds: [] }, ids, limits), "string");
    assert.equal(emoteQualityPrompt.version, manifest.emoteQuality.promptVersion);
  });
});
