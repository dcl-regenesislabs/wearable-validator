/**
 * Local run server: the website POSTs a zip, subscribes to a Server-Sent Events stream and watches the
 * visual review happen — code gate, each check, every screenshot as it lands, the prompt, the answer.
 * Previous hop: packages/debug-ui (POST /api/runs, EventSource /api/runs/:id/events).
 * Next hop: validate() with the renderer/reviewer adapters; the run folder on disk is the same one
 * tools/src/visual-review.ts writes. A hosted worker can offer this exact API later; only the storage changes.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile, appendFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPiReviewer } from "../../packages/wearable-validator/src/adapters/ai.js";
import { createRenderer } from "../../packages/wearable-validator/src/adapters/rendering.js";
import { loadInput } from "../../packages/wearable-validator/src/loader.js";
import { manifest } from "../../packages/wearable-validator/src/manifest/index.js";
import { registry } from "../../packages/wearable-validator/src/registry.js";
import { validate } from "../../packages/wearable-validator/src/validate.js";
import type { CaptureRecord, Renderer, Result, Reviewer } from "../../packages/wearable-validator/src/types.js";
import { dryRunReviewer, fileCredentials, readRun, recordingReviewer, writeRun } from "./visual-review.js";

const ROOT = resolve(import.meta.dirname, "../..");
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
  /** Where run folders are written (tools/artifacts). */
  out: string;
  /** Builds the adapters for one run; called only after the code gate passes. */
  services: (run: RunSink) => Promise<RunServices>;
  /** What /api/health reports so the website knows which buttons to show. */
  capabilities: { renderer: boolean; reviewer: "pi" | "dry-run" | "none" };
  /** Built website to serve at / (optional — Vite dev proxies /api instead). */
  site?: string;
}

interface Run {
  id: string;
  name: string;
  dir: string;
  events: RunEvent[];
  listeners: Set<ServerResponse>;
  controller: AbortController;
  done: boolean;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolvePromise(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(new Uint8Array(Buffer.concat(chunks))));
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

/** Run folders remember which zip they came from (input.json); the newest per zip wins. */
async function indexPreviousRuns(out: string, previous: Map<string, string>): Promise<void> {
  const entries = await readdir(out).catch(() => [] as string[]);
  const found: { sha256: string; dir: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("visual-")) continue;
    const dir = join(out, entry);
    try {
      const input = JSON.parse(await readFile(join(dir, "input.json"), "utf8")) as { sha256?: string };
      const info = await stat(join(dir, "captures", "captures.json"));
      if (input.sha256) found.push({ sha256: input.sha256, dir, mtime: info.mtimeMs });
    } catch {
      // not a run folder with reusable captures
    }
  }
  for (const item of found.sort((a, b) => a.mtime - b.mtime)) previous.set(item.sha256, item.dir);
}

/** Result for the wire: capture bytes become URLs the page can load. */
function serializeResult(run: Run, result: Result): unknown {
  return { ...result, captures: result.captures.map(({ bytes, ...capture }) => ({ ...capture, url: `/api/runs/${run.id}/captures/${capture.request.id}.png` })) };
}

export function createRunServer(options: ServeOptions): { server: Server; close(): Promise<void> } {
  const runs = new Map<string, Run>();
  // latest run folder per uploaded zip (sha256) — its captures are offered to the next run of the same file
  const previous = new Map<string, string>();
  let active = 0;
  void indexPreviousRuns(options.out, previous);

  function emit(run: Run, type: string, data: unknown): void {
    const event: RunEvent = { id: run.events.length + 1, type, data };
    run.events.push(event);
    const frame = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const listener of run.listeners) listener.write(frame);
    void appendFile(join(run.dir, "events.jsonl"), JSON.stringify(event) + "\n").catch(() => {});
  }

  async function execute(run: Run, bytes: Uint8Array, name: string, standalone: boolean): Promise<void> {
    active++;
    let services: RunServices | undefined;
    try {
      // the code gate judges the zip itself and costs nothing: no browser, no model until it passes
      const code = await validate(bytes, { signal: run.controller.signal, onProgress: (event) => emit(run, "check", event) });
      emit(run, "gate", { result: code, passed: code.passed });
      if (code.passed !== true && !standalone) {
        emit(run, "done", { skipped: true, result: code, message: "Visual review was not started: fix the code checks first, or run it anyway." });
        return;
      }
      const loaded = await loadInput(bytes, {});
      const thumbnail = loaded.ctx?.files.get(loaded.ctx.item.thumbnailPath ?? "thumbnail.png");
      if (thumbnail) await writeFile(join(run.dir, "thumbnail.png"), thumbnail);
      const inputSha = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(run.dir, "input.json"), JSON.stringify({ name, sha256: inputSha }));
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
        emit(run, "done", { skipped: true, message: "This server has no renderer or reviewer configured (start it with --renderer-build and --auth)." });
        return;
      }
      emit(run, "stage", { text: "Rendering the item on both body shapes" });
      const result = await validate(bytes, {
        checks: VISUAL_CHECKS,
        captures,
        services: { renderer: services.renderer, reviewer: services.reviewer },
        signal: run.controller.signal,
        onProgress: (event) => emit(run, "check", event)
      });
      await writeRun(run.dir, result, thumbnail);
      emit(run, "done", { result: serializeResult(run, result), name });
    } catch (error) {
      const message = run.controller.signal.aborted ? "The run was cancelled." : error instanceof Error ? error.message : "The run failed.";
      emit(run, "error", { message });
    } finally {
      run.done = true;
      active--;
      for (const listener of run.listeners) listener.end();
      run.listeners.clear();
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
        emit(run, "capture", { id, request: capture.request, sha256: capture.sha256, url: `/api/runs/${run.id}/captures/${id}.png` });
      }
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] !== "api") {
      if (!options.site) return json(res, 404, { message: "No website is served here. Run the Vite dev server, or start with --site." });
      const path = parts.length === 0 ? "index.html" : parts.join("/");
      return sendFile(res, options.site, path);
    }

    if (parts[1] === "health" && req.method === "GET") {
      return json(res, 200, { ok: true, visual: options.capabilities, checks: VISUAL_CHECKS, rulesVersion: manifest.version });
    }

    if (parts[1] === "runs" && parts.length === 2 && req.method === "POST") {
      if (active > 0) return json(res, 409, { message: "A run is already in progress. Wait for it to finish." });
      const bytes = await readBody(req, manifest.fileSize.maxInputBytes);
      if (!bytes) return json(res, 413, { message: `The file is larger than ${manifest.fileSize.maxInputBytes} bytes.` });
      if (bytes.length === 0) return json(res, 400, { message: "Send the zip bytes as the request body." });
      const name = basename(decodeURIComponent(req.headers["x-file-name"]?.toString() ?? "item.zip")).replace(/[^\w.-]/g, "_");
      const id = randomBytes(4).toString("hex");
      const dir = join(options.out, `visual-${name.replace(/\.zip$/i, "")}-${id}`);
      await mkdir(dir, { recursive: true });
      const run: Run = { id, name, dir, events: [], listeners: new Set(), controller: new AbortController(), done: false };
      runs.set(id, run);
      json(res, 201, { id, events: `/api/runs/${id}/events` });
      void execute(run, bytes, name, url.searchParams.get("standalone") === "1");
      return;
    }

    const run = parts[1] === "runs" ? runs.get(parts[2] ?? "") : undefined;
    if (!run) return json(res, 404, { message: "Unknown run." });

    if (parts.length === 3 && req.method === "GET") return json(res, 200, { id: run.id, name: run.name, done: run.done, events: run.events });
    if (parts.length === 3 && req.method === "DELETE") {
      run.controller.abort();
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
    handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { message: error instanceof Error ? error.message : "Request failed." });
      else res.end();
    });
  });
  return {
    server,
    close: () =>
      new Promise((resolvePromise) => {
        for (const run of runs.values()) {
          run.controller.abort();
          for (const listener of run.listeners) listener.end();
        }
        server.close(() => resolvePromise());
      })
  };
}

/** Announces the prompt before the model call and the answer after it, on top of the recording wrapper. */
export function liveReviewer(reviewer: Reviewer, run: RunSink, check: string): Reviewer {
  return {
    async review(request, signal) {
      run.emit("review", {
        check,
        phase: "request",
        promptVersion: request.prompt.version,
        promptDigest: request.promptDigest,
        images: request.images.map((image) => ({ id: image.id, label: image.label })),
        promptUrl: `/api/runs/${run.id}/${check}/1-prompt.md`
      });
      const result = await reviewer.review(request, signal);
      run.emit("review", { check, phase: "answer", ...result });
      return result;
    }
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "4180" },
      auth: { type: "string" },
      "renderer-build": { type: "string" },
      "no-ai": { type: "boolean", default: false },
      site: { type: "string" },
      out: { type: "string" }
    }
  });
  const cwd = process.env.INIT_CWD ?? process.cwd();
  // tools/renderer-build is the gitignored home for the PR #10053 Unity build, so the flag is optional once it is there
  const defaultBuild = join(ROOT, "tools/renderer-build");
  const buildDirectory = values["renderer-build"]
    ? resolve(cwd, values["renderer-build"])
    : await stat(join(defaultBuild, "avatar-preview-renderer.wasm")).then(() => defaultBuild).catch(() => undefined);
  const auth = values.auth ? resolve(cwd, values.auth) : undefined;
  const out = values.out ? resolve(cwd, values.out) : join(ROOT, "tools/artifacts");
  const site = values.site ? resolve(cwd, values.site) : join(ROOT, "packages/debug-ui/dist");
  const siteExists = await stat(join(site, "index.html")).then(() => true).catch(() => false);
  const reviewerKind = auth ? "pi" : values["no-ai"] ? "dry-run" : "none";
  if (reviewerKind === "none" && buildDirectory) console.log("No --auth given: reviews run as --no-ai (renders + prompt, no model call).");

  const { server } = createRunServer({
    out,
    capabilities: { renderer: Boolean(buildDirectory), reviewer: reviewerKind === "none" ? "dry-run" : reviewerKind },
    site: siteExists ? site : undefined,
    services: async (run) => {
      const renderer = buildDirectory ? await createRenderer({ buildDirectory, onCapture: (capture) => void run.capture(capture) }) : undefined;
      const base = auth ? createPiReviewer({ credentials: fileCredentials(auth) }) : dryRunReviewer();
      const reviewer = liveReviewer(recordingReviewer(base, run.dir, VISUAL_CHECKS[0]), run, VISUAL_CHECKS[0]);
      return { renderer, reviewer, stop: () => renderer?.stop() ?? Promise.resolve() };
    }
  });
  const port = Number(values.port);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Run server on http://127.0.0.1:${port}  renderer: ${buildDirectory ? "local Unity build" : "none"}  reviewer: ${reviewerKind}`);
    console.log(siteExists ? `Website: http://127.0.0.1:${port}/` : "Website: run `npm run dev -w wearable-validator-debug-ui` (it proxies /api here)");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "The run server failed to start.");
    process.exitCode = 1;
  });
}
