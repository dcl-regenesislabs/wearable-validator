import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureRequest, CheckResult, Finding, ProgressEvent, Result } from "@dcl-regenesislabs/wearable-validator";
import type { RunEvent, WireResult } from "../src/api.js";
import { categoryOf, codeResultOf, codeSteps, combinedVerdict, expectedReviews, itemContextOf, reduceVisual, stepAnnouncement, visualSteps, visualStepsOf, visualVerdict, EMPTY_VISUAL, type Step, type VisualEvent } from "../src/progress.js";

// ── recorded sequences ───────────────────────────────────────────────────────

const row = (check: string, group: CheckResult["group"], status: CheckResult["status"] = "passed"): CheckResult => ({ check, group, status, coverage: "complete" });
const finished = (check: string, group: CheckResult["group"], status: CheckResult["status"] = "passed", findings: Finding[] = []): ProgressEvent => ({ type: "check-finished", result: row(check, group, status), findings });
const started = (check: string, group: CheckResult["group"]): ProgressEvent => ({ type: "check-started", check, group });

const codeResult = (checks: CheckResult[], passed: boolean | null): Result => ({ passed, checks, findings: [], captures: [], summary: { errors: 0, warnings: 0, checked: checks.length, skipped: 0 } });

const WEARABLE_CODE: ProgressEvent[] = [
  started("file-format", "files"), finished("file-format", "files"),
  started("gltf-valid", "files"), finished("gltf-valid", "files"),
  started("metadata", "files"), finished("metadata", "files"),
  started("texture-count", "model"), finished("texture-count", "model"),
  started("triangle-count", "model"), finished("triangle-count", "model"),
  started("qr-code", "content"), finished("qr-code", "content")
];
const EMOTE_CODE: ProgressEvent[] = [
  started("file-format", "files"), finished("file-format", "files"),
  started("duration", "emote"), finished("duration", "emote"),
  started("audio", "emote"), finished("audio", "emote"),
  started("qr-code", "content"), finished("qr-code", "content")
];

function capture(id: string, bodyShape = "urn:decentraland:off-chain:base-avatars:BaseMale"): RunEvent {
  const request: CaptureRequest = { id, key: id, inputDigest: "d", rendererBuild: "b", recipeVersion: 4, bodyShape, mainFile: "model.glb", view: "avatar", azimuthDegrees: 0, size: 512 };
  return { type: "capture", data: { id, request, sha256: "0".repeat(64), url: `/api/runs/r/captures/${id}.png` } };
}
const metadata = { provider: "pi", model: "m", promptVersion: 1, promptDigest: "p", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, images: [], answer: "" };
const review = (check: string, verdict: string): RunEvent[] => [
  { type: "review", data: { check, phase: "request", promptVersion: 1, promptDigest: "p", images: [], promptUrl: "/api/runs/r/prompt.md" } },
  { type: "review", data: { check, phase: "answer", ok: true, answer: { verdict }, metadata } }
];
/** The dry-run reviewer: asked, but every answer is a refusal. */
const refused = (check: string): RunEvent[] => [
  { type: "review", data: { check, phase: "request", promptVersion: 1, promptDigest: "p", images: [], promptUrl: "/api/runs/r/prompt.md" } },
  { type: "review", data: { check, phase: "answer", ok: false, reason: "dry run: no reviewer configured", metadata } }
];
const AI_CHECKS = ["thumbnail-honesty", "visual-quality", "emote-quality"];

function wearableRun(views = 20): VisualEvent[] {
  const gate = codeResult(WEARABLE_CODE.filter((e) => e.type === "check-finished").map((e) => (e as Extract<ProgressEvent, { type: "check-finished" }>).result), true);
  const captures = Array.from({ length: views }, (_, i) => capture(`${i < views / 2 ? "BaseMale" : "BaseFemale"}-avatar-${String(i * 10).padStart(3, "0")}`, i < views / 2 ? "urn:decentraland:off-chain:base-avatars:BaseMale" : "urn:decentraland:off-chain:base-avatars:BaseFemale"));
  const visualRows: CheckResult[] = [row("render-valid", "rendering"), row("thumbnail-honesty", "rendering"), row("visual-quality", "rendering", "warning")];
  const result: WireResult = { passed: null, checks: [...gate.checks, ...visualRows], findings: [], captures: [], summary: { errors: 0, warnings: 1, checked: 3, skipped: 0 } };
  return [
    { type: "upload-started" },
    { type: "upload-finished", id: "r" },
    ...WEARABLE_CODE.map((data): RunEvent => ({ type: "check", data })),
    { type: "gate", data: { result: gate, passed: true } },
    { type: "queue", data: { position: 2, ahead: 2, running: 1, averageRunMs: 60_000, etaMs: 120_000 } },
    { type: "queue", data: { position: 0, ahead: 0, running: 1, averageRunMs: 60_000, etaMs: 0 } },
    { type: "stage", data: { text: "Starting the renderer" } },
    { type: "stage", data: { text: "Rendering the item on 2 body shapes", views, bodyShapes: ["BaseMale", "BaseFemale"] } },
    { type: "check", data: started("render-valid", "rendering") },
    ...captures,
    { type: "check", data: finished("render-valid", "rendering") },
    ...review("thumbnail-honesty", "matches"),
    { type: "check", data: finished("thumbnail-honesty", "rendering") },
    ...review("visual-quality", "issues"),
    { type: "check", data: finished("visual-quality", "rendering", "warning") },
    { type: "done", data: { result, zipUrl: "/api/runs/r/input.zip" } }
  ];
}

const at = (steps: Step[], key: string): Step => steps.find((step) => step.key === key)!;
const states = (steps: Step[]): string[] => steps.map((step) => step.state);

// ── code checks ──────────────────────────────────────────────────────────────

describe("code stepper", () => {
  it("is all dots before the first event", () => {
    assert.deepEqual(states(codeSteps([])), ["todo", "todo", "todo", "todo"]);
    assert.deepEqual(codeSteps([]).map((step) => step.label), ["Files & metadata", "3D model", "Animation", "Content"]);
  });

  it("names the running check by its title and counts what is done, never n/N", () => {
    const steps = codeSteps(WEARABLE_CODE.slice(0, 9));
    assert.equal(at(steps, "files").state, "done");
    assert.equal(at(steps, "files").detail, "3 checks");
    assert.equal(at(steps, "model").state, "active");
    assert.equal(at(steps, "model").detail, "Checking Triangle count · 1 done");
    assert.equal(at(steps, "emote").state, "todo");
    assert.match(at(steps, "model").detail!, /^Checking [A-Z]/);
    assert.doesNotMatch(at(steps, "model").detail!, /\d+\/\d+/);
  });

  it("marks a group with no checks as not applicable once a later group starts", () => {
    const steps = codeSteps(WEARABLE_CODE);
    assert.equal(at(steps, "emote").state, "skipped");
    assert.equal(at(steps, "emote").detail, "Not applicable");
    assert.equal(at(steps, "content").state, "active");
    assert.equal(at(steps, "content").detail, "Checking QR codes · 1 done");
  });

  it("closes the last group when the run finishes", () => {
    assert.deepEqual(states(codeSteps(WEARABLE_CODE, true)), ["done", "done", "skipped", "done"]);
    assert.deepEqual(states(codeSteps(EMOTE_CODE, true)), ["done", "skipped", "done", "done"]);
    assert.equal(at(codeSteps(EMOTE_CODE, true), "emote").detail, "2 checks");
    assert.equal(at(codeSteps(EMOTE_CODE, true), "content").detail, "1 check");
  });
});

// ── visual review ────────────────────────────────────────────────────────────

describe("visual stepper", () => {
  it("has six steps with the fixed labels", () => {
    assert.deepEqual(visualSteps([], AI_CHECKS).map((step) => step.label), ["Uploading", "Code checks re-run on the server", "In line", "Rendering", "Asking the model", "Verdict"]);
    assert.deepEqual(states(visualSteps([], AI_CHECKS)), ["todo", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("walks a wearable run: upload → gate → line → 20 views → model (k/M) → verdict", () => {
    const events = wearableRun();
    const upto = (n: number) => visualSteps(events.slice(0, n), AI_CHECKS);

    assert.equal(at(upto(1), "upload").state, "active");
    const gating = upto(2 + 9);
    assert.equal(at(gating, "upload").state, "done");
    assert.equal(at(gating, "gate").state, "active");
    assert.equal(at(gating, "gate").detail, "Checking Triangle count · 4 done");

    const queued = upto(2 + WEARABLE_CODE.length + 2);
    assert.equal(at(queued, "gate").state, "done");
    assert.equal(at(queued, "gate").detail, "Passed");
    assert.equal(at(queued, "queue").state, "active");
    assert.equal(at(queued, "queue").detail, "2 ahead · about 2 min");

    const starting = upto(2 + WEARABLE_CODE.length + 4);
    assert.equal(at(starting, "queue").state, "done");
    assert.equal(at(starting, "render").state, "active");
    assert.equal(at(starting, "render").detail, "Starting the renderer");

    const planned = upto(2 + WEARABLE_CODE.length + 5);
    assert.equal(at(planned, "render").detail, "0/20 views");
    const halfway = upto(2 + WEARABLE_CODE.length + 6 + 10);
    assert.equal(at(halfway, "render").detail, "10/20 views");

    const asking = upto(2 + WEARABLE_CODE.length + 6 + 20 + 1 + 1);
    assert.equal(at(asking, "render").state, "done");
    assert.equal(at(asking, "render").detail, "20 views");
    assert.equal(at(asking, "review").state, "active");
    assert.equal(at(asking, "review").detail, "Thumbnail honesty (1/2)");
    const second = upto(2 + WEARABLE_CODE.length + 6 + 20 + 1 + 2 + 1 + 1);
    assert.equal(at(second, "review").detail, "Visual quality (2/2)");

    const done = visualSteps(events, AI_CHECKS);
    assert.deepEqual(states(done), ["done", "done", "done", "done", "done", "done"]);
    assert.equal(at(done, "review").detail, "2 answers");
    assert.equal(at(done, "verdict").detail, "Passed");
  });

  it("counts the model calls an emote makes, not every AI check the server has", () => {
    const gate = codeResult(EMOTE_CODE.filter((e) => e.type === "check-finished").map((e) => (e as Extract<ProgressEvent, { type: "check-finished" }>).result), true);
    const events: VisualEvent[] = [
      { type: "upload-started" },
      { type: "upload-finished", id: "e" },
      ...EMOTE_CODE.map((data): RunEvent => ({ type: "check", data })),
      { type: "gate", data: { result: gate, passed: true } },
      { type: "queue", data: { position: 0, ahead: 0, running: 1, averageRunMs: null, etaMs: 0 } },
      { type: "stage", data: { text: "Rendering", views: 20 } },
      ...Array.from({ length: 20 }, (_, i) => capture(`BaseMale-avatar-000-t${i}`)),
      { type: "check", data: finished("render-valid", "rendering") },
      ...review("thumbnail-honesty", "matches"),
      { type: "check", data: finished("thumbnail-honesty", "rendering") },
      ...review("emote-quality", "ok")
    ];
    const steps = visualSteps(events, AI_CHECKS);
    assert.equal(at(steps, "review").detail, "Emote visual quality (2/2)");
    assert.equal(at(steps, "queue").detail, "No wait");
    assert.equal(expectedReviews(AI_CHECKS, "emote"), 2);
    assert.equal(expectedReviews(AI_CHECKS, "wearable"), 2);
    assert.equal(expectedReviews(AI_CHECKS, null), 3);
  });

  it("shows 'n views' while the server has not said how many it plans", () => {
    const events: VisualEvent[] = [
      { type: "upload-finished", id: "r" },
      { type: "queue", data: { position: 0, ahead: 0, running: 1, averageRunMs: null, etaMs: 0 } },
      { type: "stage", data: { text: "Rendering the item on both body shapes" } },
      capture("a"),
      capture("b")
    ];
    assert.equal(at(visualSteps(events, AI_CHECKS), "render").detail, "2 views");
    assert.equal(at(visualSteps(events.slice(0, 4), AI_CHECKS), "render").detail, "1 view");
  });

  it("says how many checks were asked when the model refused every one", () => {
    const rows: CheckResult[] = [row("render-valid", "rendering"), row("thumbnail-honesty", "rendering", "errored"), row("visual-quality", "rendering", "errored")];
    const result: WireResult = { passed: null, checks: rows, findings: [], captures: [], summary: { errors: 0, warnings: 0, checked: 1, skipped: 0 } };
    const events: VisualEvent[] = [
      { type: "upload-finished", id: "d" },
      { type: "queue", data: { position: 0, ahead: 0, running: 1, averageRunMs: null, etaMs: 0 } },
      { type: "stage", data: { text: "Rendering", views: 1 } },
      capture("a"),
      { type: "check", data: finished("render-valid", "rendering") },
      ...refused("thumbnail-honesty"),
      { type: "check", data: finished("thumbnail-honesty", "rendering", "errored") },
      ...refused("visual-quality"),
      { type: "check", data: finished("visual-quality", "rendering", "errored") },
      { type: "done", data: { result } }
    ];
    const steps = visualSteps(events, AI_CHECKS);
    assert.equal(at(steps, "review").state, "done");
    assert.equal(at(steps, "review").detail, "2 checks asked · no answer");
    assert.equal(at(steps, "verdict").detail, "No verdict");
    assert.equal(at(steps, "verdict").state, "warning", "a verdict other than Passed asks for attention, not a green check");
  });

  it("marks the server's code checks as needing attention when the item did not pass but was rendered anyway", () => {
    const events = wearableRun(2);
    const gate = events.find((event): event is Extract<VisualEvent, { type: "gate" }> => event.type === "gate")!;
    const code = { ...gate.data.result, passed: false, summary: { ...gate.data.result.summary, errors: 2 } };
    const steps = visualSteps(events.map((event) => (event === gate ? { type: "gate", data: { result: code, passed: false } } : event)), AI_CHECKS);
    assert.equal(at(steps, "gate").state, "warning");
    assert.equal(at(steps, "gate").detail, "Did not pass · 2 errors · rendered anyway");
    assert.equal(at(steps, "render").state, "done", "the run went on past the gate");
  });

  it("stops at the gate: the gate step fails and nothing after it starts", () => {
    const code = codeResult([row("file-format", "files", "failed")], false);
    const wire: WireResult = { ...code, captures: [] };
    const events: VisualEvent[] = [
      { type: "upload-started" },
      { type: "upload-finished", id: "g" },
      { type: "check", data: started("file-format", "files") },
      { type: "check", data: finished("file-format", "files", "failed") },
      { type: "gate", data: { result: code, passed: false } },
      { type: "done", data: { skipped: true, result: wire, message: "Visual review was not started: fix the code checks first, or press Render and review anyway." } }
    ];
    const steps = visualSteps(events, AI_CHECKS);
    assert.deepEqual(states(steps), ["done", "failed", "todo", "todo", "todo", "todo"]);
    assert.match(at(steps, "gate").detail!, /fix the code checks first/);
  });

  it("marks a failed run on the step it was in, with the server's message", () => {
    const events: VisualEvent[] = [
      { type: "upload-started" },
      { type: "upload-finished", id: "f" },
      { type: "queue", data: { position: 0, ahead: 0, running: 1, averageRunMs: null, etaMs: 0 } },
      { type: "stage", data: { text: "Starting the renderer", views: 10 } },
      { type: "error", data: { message: "The renderer crashed." } }
    ];
    const steps = visualSteps(events, AI_CHECKS);
    assert.deepEqual(states(steps), ["done", "done", "done", "failed", "todo", "todo"]);
    assert.equal(at(steps, "render").detail, "The renderer crashed.");
  });

  it("tells a cancel apart from a failure", () => {
    const events: VisualEvent[] = [
      { type: "upload-finished", id: "c" },
      { type: "queue", data: { position: 1, ahead: 1, running: 1, averageRunMs: null, etaMs: null } },
      { type: "cancel-requested" },
      { type: "error", data: { message: "The run was cancelled." } }
    ];
    const state = events.reduce(reduceVisual, EMPTY_VISUAL);
    assert.equal(state.phase, "cancelled");
    const steps = visualStepsOf(state, AI_CHECKS);
    assert.equal(at(steps, "queue").state, "failed");
    assert.equal(at(steps, "queue").detail, "The run was cancelled.");
    assert.equal(at(visualSteps(events.slice(0, 2), AI_CHECKS), "queue").detail, "1 ahead");
  });

  it("fails the upload step when the run cannot start", () => {
    const events: VisualEvent[] = [{ type: "upload-started" }, { type: "error", data: { message: "The run server is not reachable." } }];
    const steps = visualSteps(events, AI_CHECKS);
    assert.equal(at(steps, "upload").state, "failed");
    assert.equal(at(steps, "upload").detail, "The run server is not reachable.");
  });

  it("fails the first step when the stream is refused before any event", () => {
    const message = "Could not follow this run: too many tabs are open on it, or it is not yours.";
    const steps = visualSteps([{ type: "error", data: { message } }], AI_CHECKS);
    assert.equal(steps[0].state, "failed");
    assert.equal(steps[0].detail, message);
    assert.deepEqual(states(steps.slice(1)), ["todo", "todo", "todo", "todo", "todo"]);
  });

  it("keeps a seeded run id through the server's events", () => {
    const done = wearableRun().at(-1)!;
    assert.equal(reduceVisual({ ...EMPTY_VISUAL, id: "r1" }, done).id, "r1");
    assert.equal(reduceVisual({ ...EMPTY_VISUAL, id: "r1" }, capture("a")).id, "r1");
  });

  it("replays a finished run from its single done event", () => {
    const full = wearableRun();
    const done = full.at(-1)!;
    const state = reduceVisual(EMPTY_VISUAL, done);
    assert.equal(state.phase, "done");
    const steps = visualStepsOf(state, AI_CHECKS);
    assert.deepEqual(states(steps), ["done", "done", "done", "done", "done", "done"]);
    assert.equal(at(steps, "verdict").detail, "Passed");
    assert.equal(state.zipUrl, "/api/runs/r/input.zip");
    // an old run with nothing saved
    const empty = visualSteps([{ type: "done", data: { skipped: true, message: "This run finished without a saved result." } }], AI_CHECKS);
    assert.equal(at(empty, "verdict").state, "failed");
    assert.equal(at(empty, "verdict").detail, "This run finished without a saved result.");
    // nothing saved says what ran: the steps between upload and verdict are unknown, not done
    assert.deepEqual(states(empty), ["done", "skipped", "skipped", "skipped", "skipped", "failed"]);
    assert.equal(at(empty, "render").detail, undefined);
    assert.equal(at(empty, "review").detail, undefined);
  });

  it("announces state changes only, never the counters", () => {
    const events = wearableRun();
    const upto = (n: number) => stepAnnouncement(visualSteps(events.slice(0, n), AI_CHECKS));
    assert.equal(upto(0), "");
    assert.equal(upto(1), "Uploading in progress");
    assert.equal(upto(2 + 3), "Code checks re-run on the server in progress");
    assert.equal(upto(2 + 9), upto(2 + 3));
    const rendering = 2 + WEARABLE_CODE.length + 5;
    assert.equal(upto(rendering), "Rendering in progress");
    assert.equal(upto(rendering + 10), upto(rendering));
    assert.equal(stepAnnouncement(visualSteps(events, AI_CHECKS)), "Verdict done");
    assert.equal(stepAnnouncement(visualSteps([{ type: "upload-started" }, { type: "error", data: { message: "down" } }], AI_CHECKS)), "Uploading failed");
  });

  it("fetches a published item first: the reference run's first step counts files, not an upload", () => {
    const gate = codeResult([row("file-format", "files")], true);
    const events: VisualEvent[] = [
      { type: "upload-started", reference: true },
      { type: "upload-finished", id: "u" },
      { type: "stage", data: { text: "Fetching the item from the catalyst", kind: "fetch" } },
      { type: "stage", data: { text: "Downloading the item's files", kind: "fetch", done: 0, total: 12 } },
      { type: "stage", data: { text: "Downloading the item's files", kind: "fetch", done: 3, total: 12 } },
      { type: "check", data: started("file-format", "files") },
      { type: "check", data: finished("file-format", "files") },
      { type: "gate", data: { result: gate, passed: true } },
      { type: "queue", data: { position: 0, ahead: 0, running: 1, averageRunMs: null, etaMs: 0 } }
    ];
    const upto = (n: number) => visualSteps(events.slice(0, n), AI_CHECKS);
    assert.equal(upto(1)[0].label, "Fetching from the catalyst");
    assert.equal(upto(1)[0].state, "active");
    // the server accepted the reference but is still fetching: not at the gate yet
    assert.equal(upto(2)[0].state, "active");
    assert.equal(upto(3)[0].detail, undefined);
    assert.equal(upto(4)[0].detail, "0/12 files");
    assert.equal(upto(5)[0].detail, "3/12 files");
    assert.equal(at(upto(5), "gate").state, "todo");
    const gating = upto(6);
    assert.equal(gating[0].state, "done");
    assert.equal(gating[0].detail, "12 files");
    assert.equal(at(gating, "gate").state, "active");
    assert.equal(at(upto(8), "gate").detail, "Starting");
    assert.equal(at(upto(9), "gate").detail, "Passed");
    assert.equal(upto(9)[0].detail, "12 files");
    // an upload keeps its own words
    assert.equal(visualSteps([{ type: "upload-started" }], AI_CHECKS)[0].label, "Uploading");
    assert.equal(visualSteps([{ type: "upload-started" }, { type: "upload-finished", id: "z" }], AI_CHECKS)[0].state, "done");
  });

  it("recognises a replayed reference run from its fetch stages alone", () => {
    const state = [
      { type: "stage", data: { text: "Downloading the item's files", kind: "fetch", done: 5, total: 5 } } as VisualEvent,
      { type: "check", data: started("file-format", "files") } as VisualEvent
    ].reduce(reduceVisual, { ...EMPTY_VISUAL, id: "h" });
    assert.equal(state.reference, true);
    assert.equal(state.phase, "gate");
    assert.equal(visualStepsOf(state, AI_CHECKS)[0].label, "Fetching from the catalyst");
    assert.equal(visualStepsOf(state, AI_CHECKS)[0].detail, "5 files");
    // a fetch failure stops the run on that first step
    const failed = visualSteps([{ type: "upload-started", reference: true }, { type: "error", data: { message: "No published item found for that reference." } }], AI_CHECKS);
    assert.equal(failed[0].state, "failed");
    assert.equal(failed[0].detail, "No published item found for that reference.");
  });

  it("recognises a finished reference run replayed from disk: a lone done event carries the reference", () => {
    const gate = codeResult([row("file-format", "files")], true);
    const replayed = reduceVisual({ ...EMPTY_VISUAL, id: "h" }, { type: "done", data: { gate, reference: "urn:decentraland:matic:collections-v2:0xabc:1" } });
    assert.equal(replayed.reference, true);
    assert.equal(visualStepsOf(replayed, AI_CHECKS)[0].label, "Fetching from the catalyst");
    assert.equal(visualStepsOf(replayed, AI_CHECKS)[0].state, "done");
    // an upload's done event has no reference and does not turn the run into a fetch
    const upload = reduceVisual({ ...EMPTY_VISUAL, id: "h" }, { type: "done", data: { gate, zipUrl: "/api/runs/h/input.zip" } });
    assert.equal(upload.reference, false);
    assert.equal(visualStepsOf(upload, AI_CHECKS)[0].label, "Uploading");
    // a live reference run stays one once done, whether or not the server repeats the reference
    const live = visualSteps([{ type: "upload-started", reference: true }, { type: "done", data: { gate } }], AI_CHECKS);
    assert.equal(live[0].label, "Fetching from the catalyst");
  });

  it("keeps the server's code run from the gate event and from a finished run's done event", () => {
    const events = wearableRun();
    const streamed = events.reduce(reduceVisual, EMPTY_VISUAL);
    assert.equal(streamed.gate?.passed, true);
    assert.equal(codeResultOf(streamed), streamed.gate);
    const done = events.at(-1)! as Extract<VisualEvent, { type: "done" }>;
    const gate = codeResult([row("file-format", "files"), row("triangle-count", "model", "warning")], true);
    const replayed = reduceVisual(EMPTY_VISUAL, { type: "done", data: { ...done.data, gate } });
    assert.equal(replayed.gate, gate);
    assert.equal(codeResultOf(replayed), gate);
    assert.equal(codeResultOf(replayed)?.checks.length, 2);
    // a run stopped at the gate ends with the code result as its result
    const code = codeResult([row("file-format", "files", "failed")], false);
    const stopped = reduceVisual(EMPTY_VISUAL, { type: "done", data: { skipped: true, result: { ...code, captures: [] } } });
    assert.equal(codeResultOf(stopped)?.passed, false);
    // an old run without a saved gate has no code checks to show
    const old = reduceVisual(EMPTY_VISUAL, { type: "done", data: { result: done.data.result } });
    assert.equal(old.gate, undefined);
    assert.equal(codeResultOf(old), undefined);
    assert.equal(codeResultOf(reduceVisual(EMPTY_VISUAL, { type: "done", data: { skipped: true, message: "nothing saved" } })), undefined);
  });

  it("reads the category a gate finding names, when any does", () => {
    const named: Result = { ...codeResult([row("triangle-count", "model", "failed")], false), findings: [{ check: "triangle-count", group: "model", severity: "error", message: "m", rule: "M-01", docs: "https://docs.decentraland.org/creator/wearables/creating-wearables/", data: { category: "upper_body", hides: [] } }] };
    assert.equal(categoryOf(named), "upper_body");
    assert.equal(categoryOf(codeResult([row("file-format", "files")], true)), undefined);
    assert.equal(categoryOf(undefined), undefined);
  });

  it("reads the category and hidden slots a gate finding names, so History shows Validate's limits", () => {
    const finding = (data: Finding["data"]): Finding => ({ check: "triangle-count", group: "model", severity: "error", message: "m", rule: "M-01", docs: "https://docs.decentraland.org/creator/wearables/creating-wearables/", data });
    const named: Result = { ...codeResult([row("triangle-count", "model", "failed")], false), findings: [finding({ category: "upper_body", hides: ["lower_body", "feet"] })] };
    assert.deepEqual(itemContextOf(named), { category: "upper_body", hides: ["lower_body", "feet"] });
    const unnamed: Result = { ...codeResult([row("file-format", "files", "failed")], false), findings: [finding({ where: "model.glb" })] };
    assert.deepEqual(itemContextOf(unnamed), {});
    assert.deepEqual(itemContextOf(undefined), {});
    assert.deepEqual(itemContextOf(null), {});
  });

  it("keeps the captures a done event carries, without duplicating streamed ones", () => {
    const state = wearableRun().reduce(reduceVisual, EMPTY_VISUAL);
    assert.equal(state.captures.length, 20);
    assert.equal(state.views, 20);
    assert.deepEqual(state.bodyShapes, ["BaseMale", "BaseFemale"]);
    assert.deepEqual(state.asked, ["thumbnail-honesty", "visual-quality"]);
  });
});

// ── verdicts ─────────────────────────────────────────────────────────────────

describe("verdicts", () => {
  const passedCode = codeResult([row("file-format", "files")], true);
  it("combines code and visual rows: passed only when every row passed or warned", () => {
    assert.equal(combinedVerdict(passedCode, []), "passed");
    assert.equal(combinedVerdict(passedCode, [row("render-valid", "rendering"), row("visual-quality", "rendering", "warning")]), "passed");
    assert.equal(combinedVerdict(passedCode, [row("render-valid", "rendering", "failed")]), "failed");
    assert.equal(combinedVerdict(passedCode, [row("visual-quality", "rendering", "skipped")]), "incomplete");
    assert.equal(combinedVerdict(codeResult([], false), []), "failed");
    assert.equal(combinedVerdict(codeResult([], null), []), "incomplete");
  });

  it("judges visual rows on their own", () => {
    assert.equal(visualVerdict([]), null);
    assert.equal(visualVerdict([row("a", "rendering"), row("b", "rendering", "warning")]), true);
    assert.equal(visualVerdict([row("a", "rendering", "failed")]), false);
    assert.equal(visualVerdict([row("a", "rendering", "skipped")]), null);
  });
});
