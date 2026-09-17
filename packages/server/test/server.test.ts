import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { digest, manifest, type CaptureRecord, type Renderer, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
import { syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { renderedFrame } from "../../wearable-validator/test/helpers/frames.js";
import type { Identify } from "../src/identity.js";
import { liveReviewer, recordingReviewer } from "../src/reviewers.js";
import { createLogger } from "../src/log.js";
import { createRunServer, hostAllowed, type RunSink, type ServeOptions } from "../src/server.js";

interface Frame {
  type: string;
  data: Record<string, unknown>;
}

interface RunRow {
  id: string;
  name: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
}

const body = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const alice = { "x-test-user": "alice" };
const bob = { "x-test-user": "bob" };
const zipUpload = { "content-type": "application/zip" };
const silent = { info() {}, warn() {}, error() {} };

/** The seam under test gets a fake: whoever the x-test-user header names, nobody without it. */
const identify: Identify = async (req) => {
  const user = req.headers["x-test-user"];
  return typeof user === "string" ? { owner: user, kind: "local", operator: req.headers["x-test-operator"] === "1" } : undefined;
};
const bot = { "x-test-user": "service:slack-bot", "x-test-operator": "1" };

/** One raw HTTP/1.1 request, so the path and Host reach the server exactly as written. */
function rawRequest(base: string, path: string, host = new URL(base).host, headers: Record<string, string> = {}): Promise<string> {
  const { hostname, port } = new URL(base);
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

/** Reads one SSE stream to its end and returns the parsed frames. */
async function readEvents(url: string, headers: Record<string, string> = alice): Promise<Frame[]> {
  const text = await (await fetch(url, { headers })).text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const type = /event: (.*)/.exec(block)![1];
      const data = /data: (.*)/.exec(block)![1];
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function startRun(base: string, zip: Uint8Array, query = "", headers: Record<string, string> = alice): Promise<string> {
  const res = await fetch(`${base}/api/runs${query}`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...headers } });
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

function fakeServices(calls: { services: number; rendered: number[] }) {
  return async (run: RunSink) => {
    calls.services++;
    const size = manifest.rendering.imageSizePx;
    const bytes = renderedFrame(size);
    const renderer: Renderer = {
      buildId: "fake-build",
      capture: async (_input, requests) => {
        calls.rendered.push(requests.length);
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
        answer: { verdict: request.check === "thumbnail-honesty" ? "matches" : "ok", summary: "Same shirt.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
        metadata: { provider: "fake", model: "fixture", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
      })
    };
    // the same wrapping main() does: record the prompt/answer on disk, then announce them
    return { renderer, reviewer: liveReviewer(recordingReviewer(base, run.dir), run) };
  };
}

async function listen(options: Omit<ServeOptions, "identify" | "logger" | "capabilities"> & Partial<ServeOptions>): Promise<{ base: string; close(): Promise<void> }> {
  const created = createRunServer({ identify, logger: silent, capabilities: { renderer: true, reviewer: "dry-run" }, ...options });
  await new Promise<void>((resolve) => created.server.listen(0, "127.0.0.1", () => resolve()));
  return { base: `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`, close: created.close };
}

describe("run server", () => {
  let out: string;
  let base: string;
  let close: () => Promise<void>;
  const calls = { services: 0, rendered: [] as number[] };

  before(async () => {
    out = await mkdtemp(join(tmpdir(), "run-server-"));
    ({ base, close } = await listen({ out, services: fakeServices(calls), maxUploadBytes: 4 * 1024 * 1024 }));
  });
  after(async () => {
    await close();
    await rm(out, { recursive: true, force: true });
  });

  it("reports its capabilities, without identity, and names the caller when it can", async () => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as { visual: { renderer: boolean }; checks: string[]; owner: string | null };
    assert.equal(health.visual.renderer, true);
    assert.deepEqual(health.checks, ["render-valid", "thumbnail-honesty", "visual-quality", "emote-quality"]);
    assert.equal(health.owner, null);
    const known = (await (await fetch(`${base}/api/health`, { headers: alice })).json()) as { owner: string | null };
    assert.equal(known.owner, "alice");
  });

  it("answers 401 on every other route without an identity", async () => {
    for (const path of ["/api/runs", "/api/runs/nope", "/api/runs/nope/events", "/api/runs/nope/captures/x.png"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, path);
      assert.equal(((await res.json()) as { message: string }).message, "Sign in to use the run server.");
    }
    assert.equal((await fetch(`${base}/api/runs`, { method: "POST", body: body(await syntheticZip()) })).status, 401);
    assert.equal((await fetch(`${base}/api/runs/nope`, { method: "DELETE" })).status, 401);
  });

  it("refuses cross-site browser calls that start or cancel a run, and accepts same-origin ones", async () => {
    const zip = await syntheticZip();
    const crossSite = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice, "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    const id = await startRun(base, zip, "?model=0", { ...alice, "sec-fetch-site": "same-origin" });
    assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: { ...alice, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: { ...alice, "sec-fetch-site": "none" } })).status, 202);
    await readEvents(`${base}/api/runs/${id}/events`);
  });

  it("takes only application/zip uploads: what a form or a no-cors fetch from another site can never send", async () => {
    const zip = body(await syntheticZip());
    for (const type of [undefined, "text/plain", "multipart/form-data; boundary=x"]) {
      const res = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: type ? { ...alice, "content-type": type } : alice });
      assert.equal(res.status, 415, String(type));
      assert.match(((await res.json()) as { message: string }).message, /application\/zip/);
    }
    const id = await startRun(base, await syntheticZip(), "?model=0", { ...alice, "content-type": "Application/Zip; charset=binary" });
    await readEvents(`${base}/api/runs/${id}/events`);
  });

  it("refuses a name that does not decode without taking the run slot, and cuts a long one down to a folder name", async () => {
    const zip = await syntheticZip();
    const bad = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: body(zip), headers: { ...zipUpload, ...alice, "x-file-name": "%" } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message: string }).message, /x-file-name/);
    const long = await startRun(base, zip, "?model=0", { ...alice, "x-file-name": encodeURIComponent("a".repeat(300) + ".zip") });
    await readEvents(`${base}/api/runs/${long}/events`);
    const { runs } = (await (await fetch(`${base}/api/runs`, { headers: alice })).json()) as { runs: RunRow[] };
    const name = runs.find((row) => row.id === long)!.name;
    assert.equal(name.length, 80);
    assert.match(name, /^a+\.zip$/);
  });

  it("stops at the code gate: an item with code errors is neither rendered nor reviewed unless asked", async () => {
    const zip = await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) });
    const id = await startRun(base, zip, "", { ...alice, "x-file-name": "bad.zip" });
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("gate"));
    assert.equal(types.filter((t) => t === "capture").length, 0, "no rendering");
    assert.equal(types.filter((t) => t === "review").length, 0, "no model call");
    assert.equal((events.at(-1)!.data as { skipped?: boolean }).skipped, true);
    assert.ok(types.filter((t) => t === "check").length > 10, "the code checks stream too");
    const forced = await startRun(base, zip, "?standalone=1");
    const forcedEvents = await readEvents(`${base}/api/runs/${forced}/events`);
    assert.equal(forcedEvents.filter((e) => e.type === "capture").length, 12, "standalone renders");
    assert.equal(forcedEvents.filter((e) => e.type === "review").length, 4, "and asks the model");
  });

  it("renders without the model when asked with model=0 even if code checks pass", async () => {
    const id = await startRun(base, await syntheticZip(), "?model=0");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    assert.equal(events.filter((e) => e.type === "review").length, 0);
    assert.equal(events.filter((e) => e.type === "capture").length, 12);
  });

  it("streams every capture, the prompt and the answer, and serves the images", async () => {
    const zip = await syntheticZip();
    const id = await startRun(base, zip, "?standalone=1", { ...alice, "x-file-name": "shirt.zip" });
    assert.equal(id.length, 32, "16 random bytes as hex");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const captures = events.filter((e) => e.type === "capture");
    assert.equal(captures.length, 12);
    assert.ok(captures.some((c) => c.data.id === "BaseMale-wearable-000"), "the item-alone front view is among them");
    const reviews = events.filter((e) => e.type === "review").map((e) => `${e.data.check}:${e.data.phase}`);
    assert.deepEqual(reviews, ["thumbnail-honesty:request", "thumbnail-honesty:answer", "visual-quality:request", "visual-quality:answer"]);
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    const result = done.data.result as { checks: { check: string; status: string }[]; captures: { url: string }[] };
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:passed", "visual-quality:passed"]);
    assert.equal(result.captures.length, 12);
    const image = await fetch(`${base}${captures[3].data.url}`, { headers: alice });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(new Uint8Array(await image.arrayBuffer())[1], 0x50);
    const prompt = await fetch(`${base}/api/runs/${id}/thumbnail-honesty/1-prompt.md`, { headers: alice });
    assert.equal(prompt.status, 200);
    assert.match(await prompt.text(), /Image ID: BaseMale-avatar-000/);
    assert.ok(calls.services >= 1);
    const folder = (await (await fetch(`${base}/api/runs`, { headers: alice })).json()) as { runs: RunRow[] };
    const input = JSON.parse(await readFile(join(out, `visual-shirt-${id}`, "input.json"), "utf8")) as Record<string, unknown>;
    assert.equal(input.id, id);
    assert.equal(input.owner, "alice");
    assert.equal(input.name, "shirt.zip");
    assert.equal(input.startedAt, folder.runs.find((row) => row.id === id)!.startedAt);
    assert.equal(typeof input.sha256, "string");
  });

  it("hides a run from everyone but its owner: 404 on the run, its events, its files and cancel", async () => {
    const id = await startRun(base, await syntheticZip(), "?model=0");
    const events = await readEvents(`${base}/api/runs/${id}/events`);
    const capture = events.find((e) => e.type === "capture")!.data.url as string;
    for (const path of [`/api/runs/${id}`, `/api/runs/${id}/events`, capture]) {
      const res = await fetch(`${base}${path}`, { headers: bob });
      assert.equal(res.status, 404, path);
      assert.equal(((await res.json()) as { message: string }).message, "Unknown run.");
    }
    assert.equal((await fetch(`${base}/api/runs/${id}`, { method: "DELETE", headers: bob })).status, 404);
    assert.equal((await fetch(`${base}${capture}`, { headers: alice })).status, 200);
    const mine = (await (await fetch(`${base}/api/runs`, { headers: bob })).json()) as { runs: RunRow[] };
    assert.ok(mine.runs.every((row) => row.id !== id), "bob's list never shows alice's run");
  });

  it("lists only the caller's runs, newest first, with a verdict", async () => {
    const bobRun = await startRun(base, await syntheticZip(), "?standalone=1", { ...bob, "x-file-name": "bobs.zip" });
    await readEvents(`${base}/api/runs/${bobRun}/events`, bob);
    const older = await startRun(base, await syntheticZip(), "?standalone=1", { ...alice, "x-file-name": "older.zip" });
    await readEvents(`${base}/api/runs/${older}/events`);
    const newer = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "", { ...alice, "x-file-name": "newer.zip" });
    await readEvents(`${base}/api/runs/${newer}/events`);
    const { runs } = (await (await fetch(`${base}/api/runs`, { headers: alice })).json()) as { runs: RunRow[] };
    assert.deepEqual(runs.slice(0, 2).map((row) => row.id), [newer, older]);
    assert.ok(runs.every((row) => row.done));
    assert.ok(runs.every((row) => row.id !== bobRun));
    assert.equal(runs[0].name, "newer.zip");
    assert.equal(runs[0].passed, false, "stopped at the code gate");
    assert.equal(runs[1].passed, true, "every visual row passed");
    assert.ok(runs[0].startedAt >= runs[1].startedAt);
    const bobs = (await (await fetch(`${base}/api/runs`, { headers: bob })).json()) as { runs: RunRow[] };
    assert.deepEqual(bobs.runs.map((row) => row.id), [bobRun]);
  });

  it("shows an earlier run's photos at once and renders nothing again for the same file", async () => {
    const zip = await syntheticZip();
    const first = await startRun(base, zip, "?standalone=1");
    await readEvents(`${base}/api/runs/${first}/events`);
    const renderedBefore = calls.rendered.length;
    const second = await startRun(base, zip, "?standalone=1");
    const events = await readEvents(`${base}/api/runs/${second}/events`);
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === "capture").length, 12);
    assert.ok(types.indexOf("capture") < types.indexOf("review"), "photos arrive before the model is asked");
    assert.deepEqual(calls.rendered.slice(renderedBefore), [], "no renderer call for an unchanged file");
    assert.equal(events.at(-1)!.type, "done");
  });

  it("replays a finished run after Last-Event-ID and refuses paths outside the run folder", async () => {
    const zip = await syntheticZip();
    const id = await startRun(base, zip, "?standalone=1");
    const all = await readEvents(`${base}/api/runs/${id}/events`);
    const later = await (await fetch(`${base}/api/runs/${id}/events`, { headers: { ...alice, "last-event-id": String(all.length - 2) } })).text();
    assert.equal(later.split("\n\n").filter((block) => block.includes("event:")).length, 2);
    // fetch normalises "..", so speak raw HTTP to make sure the guard itself refuses traversal, encoded or not
    for (const path of [`/api/runs/${id}/captures/../../../etc/passwd`, `/api/runs/${id}/captures/%2e%2e/%2e%2e/%2e%2e/etc/passwd`]) {
      assert.match(await rawRequest(base, path, undefined, alice), /^HTTP\/1\.1 404/);
    }
    assert.equal((await fetch(`${base}/api/runs/nope/events`, { headers: alice })).status, 404);
  });

  it("refuses requests whose Host header is not its own address (DNS rebinding), except the health probe", async () => {
    assert.match(await rawRequest(base, "/api/runs", "attacker.example", alice), /^HTTP\/1\.1 403/);
    assert.match(await rawRequest(base, "/api/health", "attacker.example"), /^HTTP\/1\.1 200/);
    assert.match(await rawRequest(base, "/api/runs", undefined, alice), /^HTTP\/1\.1 200/);
    assert.equal(hostAllowed("localhost:4180"), true);
    assert.equal(hostAllowed("[::1]:4180"), true);
    assert.equal(hostAllowed("10.0.0.5:4180", "10.0.0.5"), true);
    assert.equal(hostAllowed("evil.example", "10.0.0.5"), false);
    assert.equal(hostAllowed("api.example.com", "0.0.0.0", ["api.example.com"]), true);
    assert.equal(hostAllowed("API.example.com:443", "0.0.0.0", ["api.example.com"]), true);
    assert.equal(hostAllowed("evil.example", "0.0.0.0", ["api.example.com"]), false);
    assert.equal(hostAllowed(undefined), false);
  });

  it("answers 413 with a message instead of dropping the connection on an oversize upload", async () => {
    const res = await fetch(`${base}/api/runs`, { method: "POST", body: new ArrayBuffer(5 * 1024 * 1024), headers: { ...zipUpload, ...alice } });
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { message: string }).message, /larger than/);
  });

  it("accepts two simultaneous uploads and runs them one after the other", async () => {
    const zip = body(await syntheticZip());
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: { ...zipUpload, ...alice } })));
    assert.deepEqual([a.status, b.status], [201, 201]);
    for (const res of [a, b]) {
      const { id } = (await res.json()) as { id: string };
      const events = await readEvents(`${base}/api/runs/${id}/events`);
      assert.equal(events.at(-1)?.type, "done");
      assert.ok(events.some((event) => event.type === "queue" && event.data.position === 0), "every run hears when its turn comes");
    }
  });
});

interface QueueView {
  running: { position: number; mine: boolean; id?: string; name?: string; since: number }[];
  waiting: { position: number; mine: boolean; id?: string; name?: string; since: number }[];
  averageRunMs: number | null;
  maxConcurrentRuns: number;
}

/** Services that do not answer until the test says so, to hold a run in the render slot. */
function heldServices(gate: { open: Promise<void> }, calls: { services: number; rendered: number[] }) {
  const real = fakeServices(calls);
  return async (run: RunSink) => {
    await gate.open;
    return real(run);
  };
}

async function queueAs(base: string, headers: Record<string, string>): Promise<QueueView> {
  return (await (await fetch(`${base}/api/queue`, { headers })).json()) as QueueView;
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

describe("the waiting line", () => {
  it("runs in arrival order, tells each run its place, names only your own items, and lets a waiting run leave", async () => {
    const out = await mkdtemp(join(tmpdir(), "run-server-queue-"));
    let release!: () => void;
    const gate = { open: new Promise<void>((resolve) => (release = resolve)) };
    const calls = { services: 0, rendered: [] as number[] };
    const { base, close } = await listen({ out, services: heldServices(gate, calls) });
    try {
      const zip = await syntheticZip();
      const a = await startRun(base, zip, "?model=0", alice);
      const b = await startRun(base, zip, "?model=0", bob);
      const c = await startRun(base, zip, "?model=0", alice);
      const view = await until(() => queueAs(base, alice), (q) => q.running.length === 1 && q.waiting.length === 2);
      assert.deepEqual(view.running.map((entry) => [entry.mine, entry.id]), [[true, a]]);
      assert.deepEqual(view.waiting.map((entry) => [entry.position, entry.mine, entry.id, entry.name]), [[1, false, undefined, undefined], [2, true, c, "item.zip"]]);
      assert.equal(view.averageRunMs, null, "no estimate before the first run finishes");
      const bobView = await queueAs(base, bob);
      assert.deepEqual(bobView.waiting.map((entry) => [entry.position, entry.mine, entry.id]), [[1, true, b], [2, false, undefined]]);
      assert.equal(bobView.running[0].id, undefined);

      const cEvents = (await (await fetch(`${base}/api/runs/${c}`, { headers: alice })).json()) as { events: Frame[] };
      const told = cEvents.events.filter((event) => event.type === "queue").at(-1)!.data;
      assert.equal(told.position, 2);
      assert.equal(told.ahead, 2);
      const mine = (await (await fetch(`${base}/api/runs`, { headers: alice })).json()) as { runs: (RunRow & { queued: boolean })[] };
      assert.deepEqual(mine.runs.map((run) => [run.id, run.queued]), [[c, true], [a, false]]);

      const cancelled = await fetch(`${base}/api/runs/${b}`, { method: "DELETE", headers: bob });
      assert.equal(cancelled.status, 202);
      const bEvents = await readEvents(`${base}/api/runs/${b}/events`, bob);
      assert.equal(bEvents.at(-1)?.type, "error");
      assert.match(String(bEvents.at(-1)?.data.message), /cancelled/);
      const moved = await until(() => queueAs(base, alice), (q) => q.waiting.length === 1);
      assert.deepEqual(moved.waiting.map((entry) => [entry.position, entry.id]), [[1, c]]);
      const cAgain = (await (await fetch(`${base}/api/runs/${c}`, { headers: alice })).json()) as { events: Frame[] };
      assert.equal(cAgain.events.filter((event) => event.type === "queue").at(-1)!.data.position, 1);

      release();
      const aEvents = await readEvents(`${base}/api/runs/${a}/events`);
      assert.equal(aEvents.at(-1)?.type, "done");
      const cDone = await readEvents(`${base}/api/runs/${c}/events`);
      assert.equal(cDone.at(-1)?.type, "done");
      assert.deepEqual(cDone.filter((event) => event.type === "queue").map((event) => event.data.position), [2, 1, 0]);
      const after = await queueAs(base, alice);
      assert.deepEqual([after.running.length, after.waiting.length], [0, 0]);
      assert.ok(typeof after.averageRunMs === "number" && after.averageRunMs >= 0);
    } finally {
      await close();
      await rm(out, { recursive: true, force: true });
    }
  });

  it("keeps a run with code errors out of the line and runs two at once when allowed", async () => {
    const out = await mkdtemp(join(tmpdir(), "run-server-queue2-"));
    let release!: () => void;
    const gate = { open: new Promise<void>((resolve) => (release = resolve)) };
    const calls = { services: 0, rendered: [] as number[] };
    const { base, close } = await listen({ out, services: heldServices(gate, calls), maxConcurrentRuns: 2 });
    try {
      const zip = await syntheticZip();
      const a = await startRun(base, zip, "?model=0", alice);
      const b = await startRun(base, zip, "?model=0", alice);
      const broken = await startRun(base, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }), "?model=0", alice);
      const brokenEvents = await readEvents(`${base}/api/runs/${broken}/events`);
      assert.equal(brokenEvents.at(-1)?.type, "done");
      assert.equal(brokenEvents.at(-1)?.data.skipped, true);
      assert.ok(!brokenEvents.some((event) => event.type === "queue"), "never joined the line");
      const view = await until(() => queueAs(base, alice), (q) => q.running.length === 2);
      assert.deepEqual(view.running.map((entry) => entry.id).sort(), [a, b].sort());
      assert.equal(view.maxConcurrentRuns, 2);
      release();
      for (const id of [a, b]) assert.equal((await readEvents(`${base}/api/runs/${id}/events`)).at(-1)?.type, "done");
    } finally {
      await close();
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("a run folder that cannot be created", () => {
  it("answers 500 without the path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "run-server-broken-"));
    const file = join(parent, "not-a-directory");
    await writeFile(file, "");
    const out = join(file, "runs");
    const { base, close } = await listen({ out, services: fakeServices({ services: 0, rendered: [] }) });
    try {
      const zip = body(await syntheticZip());
      const first = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: { ...zipUpload, ...alice } });
      assert.equal(first.status, 500);
      const answer = (await first.json()) as { message: string; reference: string };
      assert.equal(answer.message, "Request failed.");
      assert.match(answer.reference, /^[0-9a-f]{8}$/);
      const second = await fetch(`${base}/api/runs?model=0`, { method: "POST", body: zip, headers: { ...zipUpload, ...bob } });
      assert.equal(second.status, 500, "the failed upload left nothing behind");
    } finally {
      await close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("public hosts", () => {
  it("PUBLIC_HOSTS extends the Host allow list on a non-loopback bind; without it the check is skipped", async () => {
    const out = await mkdtemp(join(tmpdir(), "run-server-hosts-"));
    const services = fakeServices({ services: 0, rendered: [] });
    const gated = await listen({ out, services, host: "0.0.0.0", publicHosts: ["review.example"] });
    const open = await listen({ out, services, host: "0.0.0.0" });
    try {
      assert.match(await rawRequest(gated.base, "/api/runs", "review.example", alice), /^HTTP\/1\.1 200/);
      assert.match(await rawRequest(gated.base, "/api/runs", "attacker.example", alice), /^HTTP\/1\.1 403/);
      assert.match(await rawRequest(open.base, "/api/runs", "attacker.example", alice), /^HTTP\/1\.1 200/);
    } finally {
      await gated.close();
      await open.close();
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("runs outlive memory and restarts", () => {
  let out: string;

  before(async () => {
    out = await mkdtemp(join(tmpdir(), "run-server-disk-"));
  });
  after(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("serves an evicted finished run from its folder as one done event, and lists it again after a restart", async () => {
    const calls = { services: 0, rendered: [] as number[] };
    const first = await listen({ out, services: fakeServices(calls), maxRunsInMemory: 1 });
    const zip = await syntheticZip();
    const evicted = await startRun(first.base, zip, "?standalone=1", { ...alice, "x-file-name": "first.zip" });
    const live = await readEvents(`${first.base}/api/runs/${evicted}/events`);
    const capture = live.find((e) => e.type === "capture")!.data.url as string;
    const bobs = await startRun(first.base, zip, "?standalone=1", { ...bob, "x-file-name": "bobs.zip" });
    await readEvents(`${first.base}/api/runs/${bobs}/events`, bob);
    // the second run pushed the first out of memory: only its folder remains
    const reloaded = (await (await fetch(`${first.base}/api/runs/${evicted}`, { headers: alice })).json()) as { id: string; name: string; done: boolean; events: Frame[] };
    assert.equal(reloaded.done, true);
    assert.equal(reloaded.name, "first.zip");
    assert.equal(reloaded.events.length, 1);
    assert.equal(reloaded.events[0].type, "done");
    const result = reloaded.events[0].data.result as { checks: { check: string; status: string }[]; captures: { url: string; file?: string }[] };
    assert.deepEqual(result.checks.map((row) => `${row.check}:${row.status}`), ["render-valid:passed", "thumbnail-honesty:passed", "visual-quality:passed"]);
    assert.equal(result.captures.length, 12);
    assert.ok(result.captures.every((entry) => entry.url.startsWith(`/api/runs/${evicted}/captures/`) && entry.file === undefined));
    const replay = await readEvents(`${first.base}/api/runs/${evicted}/events`);
    assert.deepEqual(replay.map((e) => e.type), ["done"]);
    assert.equal((await fetch(`${first.base}${capture}`, { headers: alice })).status, 200);
    assert.equal((await fetch(`${first.base}/api/runs/${evicted}`, { headers: bob })).status, 404);
    await first.close();

    const second = await listen({ out, services: fakeServices(calls) });
    try {
      const { runs } = (await (await fetch(`${second.base}/api/runs`, { headers: alice })).json()) as { runs: RunRow[] };
      assert.deepEqual(runs.map((row) => [row.id, row.name, row.done, row.passed]), [[evicted, "first.zip", true, true]]);
      const bobList = (await (await fetch(`${second.base}/api/runs`, { headers: bob })).json()) as { runs: RunRow[] };
      assert.deepEqual(bobList.runs.map((row) => row.id), [bobs]);
      const restored = (await (await fetch(`${second.base}/api/runs/${evicted}`, { headers: alice })).json()) as { done: boolean; events: Frame[] };
      assert.equal(restored.done, true);
      assert.equal(restored.events[0].type, "done");
      assert.equal((await fetch(`${second.base}${capture}`, { headers: alice })).status, 200);
      assert.equal((await fetch(`${second.base}/api/runs/${evicted}`, { headers: bob })).status, 404);
    } finally {
      await second.close();
    }
  });
});

describe("operators", () => {
  it("see every run, the stats and the log; curators get 403 for those and 404 for each other's runs", async () => {
    const out = await mkdtemp(join(tmpdir(), "run-server-ops-"));
    const lines: string[] = [];
    const logger = createLogger({ format: "json", write: (line) => lines.push(line) });
    const { base, close } = await listen({ out, services: fakeServices({ services: 0, rendered: [] }), logger });
    try {
      const zip = await syntheticZip();
      const a = await startRun(base, zip, "?model=0", alice);
      await readEvents(`${base}/api/runs/${a}/events`);
      const b = await startRun(base, zip, "?model=0", bob);
      await readEvents(`${base}/api/runs/${b}/events`, bob);

      assert.equal((await fetch(`${base}/api/stats`, { headers: alice })).status, 403);
      assert.equal((await fetch(`${base}/api/logs`, { headers: alice })).status, 403);
      assert.equal((await fetch(`${base}/api/runs?all=1`, { headers: alice })).status, 403);
      assert.equal((await fetch(`${base}/api/runs/${b}`, { headers: alice })).status, 404);

      const every = (await (await fetch(`${base}/api/runs?all=1`, { headers: bot })).json()) as { runs: { id: string; owner: string }[] };
      assert.deepEqual(every.runs.map((run) => [run.id, run.owner]), [[b, "bob"], [a, "alice"]]);
      const own = (await (await fetch(`${base}/api/runs`, { headers: bot })).json()) as { runs: unknown[] };
      assert.equal(own.runs.length, 0, "without all=1 an operator lists only its own runs");
      assert.equal((await fetch(`${base}/api/runs/${b}`, { headers: bot })).status, 200);
      assert.equal((await fetch(`${base}/api/runs/${a}/events`, { headers: bot })).status, 200);

      const stats = (await (await fetch(`${base}/api/stats`, { headers: bot })).json()) as { runs: { total: number; passed: number }; byOwner: { owner: string; runs: number }[]; byDay: { runs: number }[]; rulesVersion: string };
      assert.equal(stats.runs.total, 2);
      assert.deepEqual(stats.byOwner.map((row) => row.runs), [1, 1]);
      assert.equal(stats.byDay.reduce((sum, row) => sum + row.runs, 0), 2);
      assert.equal(stats.rulesVersion, manifest.version);

      const logs = (await (await fetch(`${base}/api/logs?limit=500`, { headers: bot })).json()) as { lines: { message: string; fields: Record<string, unknown> }[] };
      assert.ok(logs.lines.some((line) => line.message === "run accepted" && line.fields.owner === "alice"));
      assert.ok(logs.lines.some((line) => line.message === "request" && line.fields.path === "/api/stats" && line.fields.status === 403 && line.fields.owner === "alice"), "every API call is one access-log line with its caller");
      assert.ok(!logs.lines.some((line) => line.message === "request" && line.fields.path === "/api/health"));
      const since = logs.lines.at(-1)!;
      const later = (await (await fetch(`${base}/api/logs?since=${encodeURIComponent((since as { time?: string }).time ?? "")}`, { headers: bot })).json()) as { lines: unknown[] };
      assert.ok(later.lines.length < logs.lines.length);
    } finally {
      await close();
      await rm(out, { recursive: true, force: true });
    }
  });
});
