/**
 * Run server: the website POSTs a zip, subscribes to a Server-Sent Events stream and watches the
 * visual review happen — code gate, each check, every screenshot as it lands, the prompt, the answer.
 * Every run belongs to the identity that started it (identity.ts); other callers cannot tell it exists.
 * Previous hop: main.ts wires the adapters and listens; the web app calls in (POST /api/runs, EventSource /api/runs/:id/events).
 * Next hop: validate() with the renderer/reviewer adapters; the run folder on disk is the same one
 * runs.ts writes for the CLI (review.ts). A hosted worker can offer this exact API later; only the storage changes.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile, appendFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { loadInput, manifest, registry, validate, type CaptureRecord, type Renderer, type Result, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
import type { Identify, Identity } from "./identity.js";
import { createLogger, type Logger } from "./log.js";
import { readRun, readRunInput, readRunResult, verdict, writeRun, writeRunInput } from "./runs.js";

const VISUAL_CHECKS = registry.filter((check) => check.group === "rendering").map((check) => check.name);
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".zip": "application/zip", ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".ico": "image/x-icon"
};

export interface RunEvent {
  id: number;
  type: string;
  data: unknown;
}

/** What a run hands the adapters: where to write and how to tell the browser. */
export interface RunSink {
  id: string;
  dir: string;
  emit(type: string, data: unknown): void;
  /** Writes the PNG into the run folder and announces its URL. */
  capture(capture: CaptureRecord): Promise<void>;
}

export interface RunServices {
  renderer?: Renderer;
  reviewer?: Reviewer;
  stop?(): Promise<void>;
}

export interface ServeOptions {
  /** Where run folders are written (packages/server/artifacts). */
  out: string;
  /** Builds the adapters for one run; called only after the code gate passes. */
  services: (run: RunSink) => Promise<RunServices>;
  /** What /api/health reports so the website knows which buttons to show. */
  capabilities: { renderer: boolean; reviewer: "pi" | "dry-run" | "none" };
  /** Who is calling; every /api route past /health refuses requests it cannot name. */
  identify: Identify;
  /** Built website to serve at / (optional — Vite dev proxies /api instead). */
  site?: string;
  /** The bind address; requests whose Host header names anything else are refused (DNS rebinding). */
  host?: string;
  /** Hostnames a public deployment answers on; without them a non-loopback host skips the Host check. */
  publicHosts?: string[];
  /** Upload cap; defaults to manifest.fileSize.maxInputBytes. */
  maxUploadBytes?: number;
  /** Finished runs kept in memory with their events; the run folder stays the durable record. */
  maxRunsInMemory?: number;
  /** Renders that may run at once (one per ~2 GB of RAM); every other accepted run waits in line. */
  maxConcurrentRuns?: number;
  logger?: Logger;
}

/** What the run list shows and what survives eviction and restarts. */
interface RunSummary {
  id: string;
  owner: string;
  name: string;
  dir: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
}

interface Run extends RunSummary {
  events: RunEvent[];
  listeners: Set<ServerResponse>;
  controller: AbortController;
  /** When the render actually started; startedAt is when the upload was accepted. */
  beganAt?: number;
}

/** A run that passed the code gate and is waiting for a render slot. */
interface Pending {
  run: Run;
  bytes: Uint8Array;
  name: string;
  mode: { model: boolean; standalone: boolean };
}

/** What every waiting run is told, and what /api/queue shows: position 0 means running. */
export interface QueuePosition {
  position: number;
  ahead: number;
  running: number;
  averageRunMs: number | null;
  etaMs: number | null;
}

export interface QueueEntry {
  position: number;
  mine: boolean;
  /** Only your own items are named; another curator's item is just "an item". */
  id?: string;
  name?: string;
  since: number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_RUNS_IN_MEMORY = 50;
// the wait estimate averages the last few renders; the first run of a fresh server has no estimate
const DURATION_SAMPLES = 5;
// the upload's name becomes part of the run folder name; filesystems cap a folder name at 255 bytes
const MAX_NAME_CHARS = 80;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
// model text reaches the operator's terminal before any parser sees it: never let it carry escape sequences
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (value: unknown, max: number): string => String(value ?? "").replace(CONTROL, " ").slice(0, max);
const bareHost = (host: string): string => host.replace(/^\[|\]$/g, "").toLowerCase();

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(bareHost(host));
}

/** A page that DNS-rebinds its hostname to this address is same-origin with us; the Host header still names the attacker. */
export function hostAllowed(header: string | undefined, configured?: string, publicHosts: string[] = []): boolean {
  if (!header) return false;
  try {
    const { hostname } = new URL(`http://${header}`);
    const bare = bareHost(hostname);
    return LOOPBACK.has(bare) || (configured !== undefined && bare === bareHost(configured)) || publicHosts.some((host) => bareHost(host) === bare);
  } catch {
    return false;
  }
}

/** Browsers stamp cross-site requests; a cookie-riding call from another site never starts or cancels a run. */
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site !== undefined && site !== "same-origin" && site !== "none";
}

/** Forms and no-cors fetches cannot send this type, so a browser too old to stamp Sec-Fetch-Site still cannot start a run from another site. */
function isZipUpload(req: IncomingMessage): boolean {
  return req.headers["content-type"]?.split(";")[0].trim().toLowerCase() === "application/zip";
}

/** The upload's name as the browser URL-encoded it, made safe for a folder name; undefined when it does not decode. */
function fileName(header: string | string[] | undefined): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(header?.toString() ?? "item.zip");
  } catch {
    return undefined;
  }
  const safe = basename(decoded).replace(/[^\w.-]/g, "_");
  const ext = extname(safe);
  return safe.length > MAX_NAME_CHARS ? safe.slice(0, MAX_NAME_CHARS - ext.length) + ext : safe;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Collects the body up to `limit`; past it the rest is drained and discarded so the 413 reaches a client still uploading. */
function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (overflowed) return;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(overflowed ? undefined : new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/** Serves one file from inside root; anything that escapes root is a 404, never a read. */
async function sendFile(res: ServerResponse, root: string, relativePath: string): Promise<void> {
  const target = resolve(root, relativePath);
  if (!target.startsWith(resolve(root) + "/") && target !== resolve(root)) {
    json(res, 404, { message: "Not found." });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream", "content-length": info.size, "cache-control": "no-cache" });
    res.end(await readFile(target));
  } catch {
    json(res, 404, { message: "Not found." });
  }
}

/**
 * Run folders remember which zip they came from and who started them (input.json): the newest per zip offers its
 * captures to the next run of the same file, and every owned folder is listed and served again after a restart.
 */
async function indexRunFolders(out: string, previous: Map<string, string>, index: Map<string, RunSummary>): Promise<void> {
  const entries = await readdir(out).catch(() => [] as string[]);
  const reusable: { sha256: string; dir: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("visual-")) continue;
    const dir = join(out, entry);
    const input = await readRunInput(dir);
    if (!input) continue;
    if (input.sha256) {
      const info = await stat(join(dir, "captures", "captures.json")).catch(() => undefined);
      if (info) reusable.push({ sha256: input.sha256, dir, mtime: info.mtimeMs });
    }
    if (input.id && input.owner) {
      const result = await readRunResult(dir);
      index.set(input.id, { id: input.id, owner: input.owner, name: input.name ?? entry, dir, startedAt: input.startedAt ?? 0, done: true, passed: result ? verdict(result) : null });
    }
  }
  for (const item of reusable.sort((a, b) => a.mtime - b.mtime)) previous.set(item.sha256, item.dir);
}

/** What a run's event means in one log line — the same stream the browser sees, with the noise left out. */
function logEvent(log: Logger, run: Run, type: string, data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>;
  const ms = Date.now() - run.startedAt;
  switch (type) {
    case "check": {
      const event = d as { type: string; check?: string; result?: { check: string; status: string; measured?: string; skipReason?: string } };
      if (event.type === "check-finished" && event.result && event.result.status !== "passed") {
        // the reason is what an operator needs when a render errors: the row on the site shows the same text
        log.info("check finished", { run: run.id, check: event.result.check, status: event.result.status, measured: event.result.measured, reason: clean(event.result.skipReason, 300) || undefined, ms });
      }
      return;
    }
    case "gate": {
      const result = d.result as { passed: boolean | null; summary: { errors: number; warnings: number; checked: number } };
      log.info("code gate", { run: run.id, passed: result.passed, errors: result.summary.errors, warnings: result.summary.warnings, checks: result.summary.checked, ms });
      return;
    }
    case "stage":
      log.info(clean(d.text, 200), { run: run.id, ms });
      return;
    case "queue":
      log.info(d.position === 0 ? "run started" : "waiting in line", { run: run.id, position: d.position, ahead: d.ahead, etaMs: d.etaMs, ms });
      return;
    case "capture":
      log.info("captured", { run: run.id, view: d.id, ms });
      return;
    case "review": {
      if (d.phase === "request") {
        const images = d.images as unknown[];
        log.info("asking the model", { run: run.id, check: d.check, prompt: `v${d.promptVersion}`, digest: String(d.promptDigest).slice(0, 8), images: images.length, ms });
        return;
      }
      const metadata = d.metadata as { model?: string; stopReason?: string; usage?: { input: number; output: number; cacheRead: number; cost: number } };
      const answer = d.answer as { verdict?: string; summary?: string; findings?: unknown[] } | undefined;
      if (d.ok) {
        log.info("model answered", {
          run: run.id, check: d.check, model: metadata.model, verdict: answer?.verdict, findings: answer?.findings?.length ?? 0,
          input: metadata.usage?.input, output: metadata.usage?.output, cacheRead: metadata.usage?.cacheRead,
          cost: metadata.usage ? `$${metadata.usage.cost.toFixed(4)}` : undefined, ms, summary: clean(answer?.summary, 160)
        });
      } else {
        log.warn("model did not answer", { run: run.id, check: d.check, model: metadata.model, stop: metadata.stopReason, reason: clean(d.reason, 200), ms });
      }
      return;
    }
    case "done": {
      const result = d.result as { checks: { check: string; status: string }[] } | undefined;
      if (result) log.info("run finished", { run: run.id, rows: result.checks.map((row) => `${row.check}:${row.status}`).join(","), ms });
      else log.info("run stopped at the gate", { run: run.id, reason: d.message, ms });
      return;
    }
    case "error":
      log.error("run failed", { run: run.id, error: clean(d.message, 300), ms });
      return;
  }
}

const captureUrl = (runId: string, captureId: string): string => `/api/runs/${runId}/captures/${captureId}.png`;

/** Result for the wire: capture bytes become URLs the page can load. */
function serializeResult(run: Run, result: Result): unknown {
  return { ...result, captures: result.captures.map(({ bytes, ...capture }) => ({ ...capture, url: captureUrl(run.id, capture.request.id) })) };
}

/** An evicted or pre-restart run comes back from its folder as one `done` event: the same shape the live stream ended with. */
async function loadFinishedRun(summary: RunSummary): Promise<Run> {
  const stored = await readRunResult(summary.dir);
  const data = stored
    ? { result: { ...stored, captures: stored.captures.map(({ file, ...capture }) => ({ ...capture, url: captureUrl(summary.id, capture.request.id) })) }, name: summary.name }
    : { skipped: true, message: "This run finished without a saved result." };
  return { ...summary, done: true, events: [{ id: 1, type: "done", data }], listeners: new Set(), controller: new AbortController() };
}

const summarize = ({ id, owner, name, dir, startedAt, done, passed }: RunSummary): RunSummary => ({ id, owner, name, dir, startedAt, done, passed });

export function createRunServer(options: ServeOptions): { server: Server; close(): Promise<void> } {
  const runs = new Map<string, Run>();
  // every run this server has ever seen, by id; live runs are in `runs` too, the rest come back from disk on demand
  const index = new Map<string, RunSummary>();
  // latest run folder per uploaded zip (sha256) — its captures are offered to the next run of the same file
  const previous = new Map<string, string>();
  const log = options.logger ?? createLogger();
  const maxRunsInMemory = options.maxRunsInMemory ?? MAX_RUNS_IN_MEMORY;
  const checkHost = options.host === undefined || isLoopback(options.host) || (options.publicHosts?.length ?? 0) > 0;
  if (!checkHost) log.warn("Host header check skipped: set PUBLIC_HOSTS to the hostnames this server answers on", { host: options.host });
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrentRuns ?? 1));
  const running = new Set<Run>();
  const waiting: Pending[] = [];
  const durations: number[] = [];
  const indexed = indexRunFolders(options.out, previous, index).catch((error) => log.warn("could not index earlier runs", { error: error instanceof Error ? error.message : String(error) }));

  function emit(run: Run, type: string, data: unknown): void {
    const event: RunEvent = { id: run.events.length + 1, type, data };
    run.events.push(event);
    logEvent(log, run, type, data);
    const frame = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const listener of run.listeners) listener.write(frame);
    void appendFile(join(run.dir, "events.jsonl"), JSON.stringify(event) + "\n").catch(() => {});
  }

  function finish(run: Run, data: { result?: Result; skipped?: boolean; message?: string }, wire: unknown = data): void {
    run.passed = data.result ? verdict(data.result) : null;
    emit(run, "done", wire);
  }

  /** The run is over, whatever the outcome: the folder is the record, the stream closes. */
  function conclude(run: Run): void {
    run.done = true;
    index.set(run.id, summarize(run));
    for (const listener of run.listeners) listener.end();
    run.listeners.clear();
  }

  function fail(run: Run, error: unknown): void {
    const message = run.controller.signal.aborted ? "The run was cancelled." : error instanceof Error ? error.message : "The run failed.";
    emit(run, "error", { message });
  }

  function averageRunMs(): number | null {
    return durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : null;
  }

  function positionOf(index: number): QueuePosition {
    const average = averageRunMs();
    return { position: index + 1, ahead: running.size + index, running: running.size, averageRunMs: average, etaMs: average === null ? null : Math.ceil((index + 1) / maxConcurrent) * average };
  }

  /** Every waiting run hears its new place whenever the line moves. */
  function broadcastQueue(): void {
    waiting.forEach((pending, index) => emit(pending.run, "queue", positionOf(index)));
  }

  function queueSnapshot(owner: string): { running: QueueEntry[]; waiting: QueueEntry[]; averageRunMs: number | null; maxConcurrentRuns: number } {
    const entry = (run: Run, position: number, since: number): QueueEntry =>
      run.owner === owner ? { position, mine: true, id: run.id, name: run.name, since } : { position, mine: false, since };
    return {
      running: [...running].map((run) => entry(run, 0, run.beganAt ?? run.startedAt)),
      waiting: waiting.map((pending, index) => entry(pending.run, index + 1, pending.run.startedAt)),
      averageRunMs: averageRunMs(),
      maxConcurrentRuns: maxConcurrent
    };
  }

  /** Starts renders while there are free slots, in arrival order. */
  function pump(): void {
    while (running.size < maxConcurrent && waiting.length) {
      const next = waiting.shift()!;
      running.add(next.run);
      next.run.beganAt = Date.now();
      emit(next.run, "queue", { position: 0, ahead: 0, running: running.size, averageRunMs: averageRunMs(), etaMs: 0 });
      void execute(next).finally(() => {
        running.delete(next.run);
        if (!next.run.controller.signal.aborted) {
          durations.push(Date.now() - next.run.beganAt!);
          if (durations.length > DURATION_SAMPLES) durations.shift();
        }
        pump();
        broadcastQueue();
      });
    }
  }

  /** The code gate runs at once (it costs nothing); only a run that needs the renderer joins the line. */
  async function admit(pending: Pending): Promise<void> {
    const { run, bytes, mode } = pending;
    try {
      const code = await validate(bytes, { signal: run.controller.signal, onProgress: (event) => emit(run, "check", event) });
      emit(run, "gate", { result: code, passed: code.passed });
      if (code.passed !== true && !mode.standalone) {
        finish(run, { skipped: true, result: code, message: "Visual review was not started: fix the code checks first, or press Render and review anyway." });
        conclude(run);
        return;
      }
    } catch (error) {
      fail(run, error);
      conclude(run);
      return;
    }
    waiting.push(pending);
    log.info("run queued", { run: run.id, position: waiting.length, running: running.size });
    broadcastQueue();
    pump();
  }

  async function execute({ run, bytes, name, mode }: Pending): Promise<void> {
    let services: RunServices | undefined;
    try {
      const askModel = mode.model;
      const loaded = await loadInput(bytes, {});
      const thumbnail = loaded.ctx?.files.get(loaded.ctx.item.thumbnailPath ?? "thumbnail.png");
      if (thumbnail) await writeFile(join(run.dir, "thumbnail.png"), thumbnail);
      const inputSha = createHash("sha256").update(bytes).digest("hex");
      await writeRunInput(run.dir, { id: run.id, owner: run.owner, name, startedAt: run.startedAt, sha256: inputSha });
      // an earlier run of the same file: show its photos now; only stale or missing views get rendered again
      const earlier = previous.get(inputSha);
      const captures = earlier && earlier !== run.dir ? await readRun(earlier).catch(() => []) : [];
      previous.set(inputSha, run.dir);
      const io = sink(run);
      if (captures.length) {
        emit(run, "stage", { text: `Reusing ${captures.length} views from an earlier run` });
        for (const capture of captures) await io.capture(capture);
      }
      emit(run, "stage", { text: "Starting the renderer" });
      services = await options.services(io);
      if (!services.renderer && !services.reviewer) {
        finish(run, { skipped: true, message: "This server has no renderer or reviewer configured (start it with --renderer-build and ANTHROPIC_OAUTH_SETUP_TOKEN)." });
        return;
      }
      emit(run, "stage", { text: "Rendering the item on both body shapes" });
      const result = await validate(bytes, {
        checks: VISUAL_CHECKS,
        captures,
        services: { renderer: services.renderer, reviewer: askModel ? services.reviewer : undefined },
        signal: run.controller.signal,
        onProgress: (event) => emit(run, "check", event)
      });
      await writeRun(run.dir, result, thumbnail);
      finish(run, { result }, { result: serializeResult(run, result), name });
    } catch (error) {
      fail(run, error);
    } finally {
      conclude(run);
      await services?.stop?.().catch(() => {});
    }
  }

  function sink(run: Run): RunSink {
    return {
      id: run.id,
      dir: run.dir,
      emit: (type, data) => emit(run, type, data),
      capture: async (capture) => {
        const { id } = capture.request;
        if (!/^[\w.-]+$/.test(id)) throw new Error(`Capture id "${id}" is not a safe file stem.`);
        await mkdir(join(run.dir, "captures"), { recursive: true });
        await writeFile(join(run.dir, "captures", `${id}.png`), capture.bytes);
        emit(run, "capture", { id, request: capture.request, sha256: capture.sha256, url: captureUrl(run.id, id) });
      }
    };
  }

  /** Your runs; an operator asking for everyone's also sees who owns each. */
  function listRuns(identity: Identity, everyone: boolean): (Omit<RunSummary, "owner" | "dir"> & { owner?: string; queued: boolean })[] {
    const all = everyone && identity.operator;
    return [...index.values()]
      .filter((run) => all || run.owner === identity.owner)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ id, owner, name, startedAt, done, passed }) => ({ id, ...(all ? { owner } : {}), name, startedAt, done, passed, queued: waiting.some((pending) => pending.run.id === id) }));
  }

  /** Someone else's run is indistinguishable from no run at all; operators see every run. */
  async function findRun(id: string | undefined, identity: Identity): Promise<Run | undefined> {
    if (!id) return undefined;
    const mine = (owner: string) => identity.operator || owner === identity.owner;
    const live = runs.get(id);
    if (live) return mine(live.owner) ? live : undefined;
    const summary = index.get(id);
    return summary && mine(summary.owner) ? loadFinishedRun(summary) : undefined;
  }

  const startedAt = Date.now();

  /** What an operator (the Slack bot) asks for: how many, how they went, who, how busy. Counts come from the run folders on disk. */
  function stats(): unknown {
    const all = [...index.values()];
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const byDay = new Map<string, { runs: number; passed: number; failed: number }>();
    const byOwner = new Map<string, number>();
    for (const run of all) {
      const bucket = byDay.get(day(run.startedAt)) ?? { runs: 0, passed: 0, failed: 0 };
      bucket.runs++;
      if (run.passed === true) bucket.passed++;
      if (run.passed === false) bucket.failed++;
      byDay.set(day(run.startedAt), bucket);
      byOwner.set(run.owner, (byOwner.get(run.owner) ?? 0) + 1);
    }
    return {
      runs: {
        total: all.length,
        passed: all.filter((run) => run.passed === true).length,
        failed: all.filter((run) => run.passed === false).length,
        noVerdict: all.filter((run) => run.done && run.passed === null).length,
        running: running.size,
        waiting: waiting.length
      },
      byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([date, counts]) => ({ date, ...counts })),
      byOwner: [...byOwner].sort(([, a], [, b]) => b - a).map(([owner, runs]) => ({ owner, runs })),
      averageRunMs: averageRunMs(),
      maxConcurrentRuns: maxConcurrent,
      firstRunAt: all.length ? Math.min(...all.map((run) => run.startedAt)) : null,
      serverStartedAt: startedAt,
      rulesVersion: manifest.version
    };
  }

  // one line per API request once it is answered: who, what, how it went, how long
  const callers = new WeakMap<ServerResponse, Identity>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const health = parts[0] === "api" && parts[1] === "health" && parts.length === 2;

    if (!health && checkHost && !hostAllowed(req.headers.host, options.host, options.publicHosts)) {
      log.warn("request refused, unexpected Host header", { host: clean(req.headers.host, 100) });
      return json(res, 403, { message: "This server only answers requests addressed to its own host." });
    }

    if (parts[0] !== "api") {
      if (!options.site) return json(res, 404, { message: "No website is served here. Run the Vite dev server, or start with --site." });
      const path = parts.length === 0 ? "index.html" : parts.join("/");
      return sendFile(res, options.site, path);
    }

    if (health && req.method === "GET") {
      const identity = await options.identify(req).catch(() => undefined);
      return json(res, 200, { ok: true, visual: options.capabilities, checks: VISUAL_CHECKS, rulesVersion: manifest.version, owner: identity?.owner ?? null });
    }

    const identity = await options.identify(req);
    if (identity) callers.set(res, identity);
    if (!identity) {
      log.warn("request refused, no identity", { method: req.method, path: clean(url.pathname, 200) });
      return json(res, 401, { message: "Sign in to use the run server." });
    }
    await indexed;

    if (parts[1] === "runs" && parts.length === 2 && req.method === "GET") {
      if (url.searchParams.get("all") === "1" && !identity.operator) return json(res, 403, { message: "Only operators can list every curator's runs." });
      return json(res, 200, { runs: listRuns(identity, url.searchParams.get("all") === "1") });
    }
    if (parts[1] === "queue" && parts.length === 2 && req.method === "GET") return json(res, 200, queueSnapshot(identity.owner));
    if (parts[1] === "stats" && parts.length === 2 && req.method === "GET") {
      if (!identity.operator) return json(res, 403, { message: "Only operators can read the stats." });
      return json(res, 200, stats());
    }
    if (parts[1] === "logs" && parts.length === 2 && req.method === "GET") {
      if (!identity.operator) return json(res, 403, { message: "Only operators can read the log." });
      const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
      const since = url.searchParams.get("since");
      const lines = (log.recent?.(limit) ?? []).filter((entry) => !since || entry.time > since);
      return json(res, 200, { lines });
    }

    if (parts[1] === "runs" && parts.length === 2 && req.method === "POST") {
      if (crossSite(req)) return json(res, 403, { message: "Cross-site requests cannot start a run." });
      if (!isZipUpload(req)) return json(res, 415, { message: "Send the zip bytes with content-type: application/zip." });
      const name = fileName(req.headers["x-file-name"]);
      if (name === undefined) return json(res, 400, { message: "x-file-name must be a URL-encoded file name." });
      {
        const limit = options.maxUploadBytes ?? manifest.fileSize.maxInputBytes;
        const bytes = await readBody(req, limit).catch(() => undefined);
        if (!bytes) return json(res, 413, { message: `The file is larger than ${limit} bytes.` });
        if (bytes.length === 0) return json(res, 400, { message: "Send the zip bytes as the request body." });
        const id = randomBytes(16).toString("hex");
        const dir = join(options.out, `visual-${name.replace(/\.zip$/i, "")}-${id}`);
        await mkdir(dir, { recursive: true });
        const run: Run = { id, owner: identity.owner, name, dir, events: [], listeners: new Set(), controller: new AbortController(), done: false, passed: null, startedAt: Date.now() };
        await writeRunInput(dir, { id, owner: run.owner, name, startedAt: run.startedAt });
        runs.set(id, run);
        index.set(id, summarize(run));
        for (const [oldId, old] of runs) {
          if (runs.size <= maxRunsInMemory) break;
          if (old.done) runs.delete(oldId);
        }
        log.info("run accepted", { run: id, owner: identity.owner, file: name, bytes: bytes.length, model: url.searchParams.get("model") !== "0", standalone: url.searchParams.get("standalone") === "1", dir });
        json(res, 201, { id, events: `/api/runs/${id}/events`, queue: `/api/queue` });
        void admit({ run, bytes, name, mode: { model: url.searchParams.get("model") !== "0", standalone: url.searchParams.get("standalone") === "1" } });
      }
      return;
    }

    const run = parts[1] === "runs" ? await findRun(parts[2], identity) : undefined;
    if (!run) return json(res, 404, { message: "Unknown run." });

    if (parts.length === 3 && req.method === "GET") return json(res, 200, { id: run.id, name: run.name, done: run.done, events: run.events });
    if (parts.length === 3 && req.method === "DELETE") {
      if (crossSite(req)) return json(res, 403, { message: "Cross-site requests cannot cancel a run." });
      log.info("run cancelled by the client", { run: run.id });
      run.controller.abort();
      const place = waiting.findIndex((pending) => pending.run === run);
      if (place >= 0) {
        // never started: leave the line and close the stream ourselves, there is no execute() to do it
        waiting.splice(place, 1);
        fail(run, undefined);
        conclude(run);
        broadcastQueue();
      }
      return json(res, 202, { id: run.id, cancelled: true });
    }
    if (parts[3] === "events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 2000\n\n");
      // replay everything after Last-Event-ID so a refresh or a late tab sees the whole run
      const after = Number(req.headers["last-event-id"] ?? 0) || 0;
      for (const event of run.events) {
        if (event.id > after) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      if (run.done) {
        res.end();
        return;
      }
      run.listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        run.listeners.delete(res);
      });
      return;
    }
    if (req.method === "GET" && parts.length >= 4) return sendFile(res, run.dir, parts.slice(3).join("/"));
    json(res, 404, { message: "Not found." });
  }

  const server = createServer((req, res) => {
    const began = Date.now();
    res.on("finish", () => {
      const path = (req.url ?? "/").split("?")[0];
      // health probes and the site's static files would drown the log; every API call is one line
      if (!path.startsWith("/api/") || path === "/api/health") return;
      const identity = callers.get(res);
      log.info("request", { method: req.method, path: clean(path, 200), status: res.statusCode, ms: Date.now() - began, owner: identity?.owner, kind: identity?.kind });
    });
    handle(req, res).catch((error) => {
      // the reason (paths, upstream URLs) stays in the log; the client gets a reference to find it by
      const reference = randomBytes(4).toString("hex");
      log.error("request failed", { reference, method: req.method, url: req.url, error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) json(res, 500, { message: "Request failed.", reference });
      else res.end();
    });
  });
  return {
    server,
    close: () =>
      new Promise((resolvePromise) => {
        for (const pending of waiting.splice(0)) {
          emit(pending.run, "error", { message: "The server is restarting. Start the run again in a moment." });
          conclude(pending.run);
        }
        for (const run of runs.values()) {
          run.controller.abort();
          for (const listener of run.listeners) listener.end();
        }
        server.close(() => resolvePromise());
      })
  };
}
