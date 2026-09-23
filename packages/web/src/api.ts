/**
 * The run server's API (packages/server): start a run, follow it over Server-Sent Events, list your runs.
 * In dev, Vite proxies /api to it; on the static site there is no server and every call fails soft.
 */
import type { CaptureRecord, CaptureRequest, CheckResult, Finding, ProgressEvent, Result, ReviewMetadata } from "@dcl-regenesislabs/wearable-validator";
import { runLoadMessage } from "./run-list.js";

export interface VisualCapabilities {
  renderer: boolean;
  reviewer: "pi" | "dry-run" | "none";
}

export interface VisualHealth {
  visual: VisualCapabilities;
  checks: string[];
  /** Who the server thinks is calling: "local" without sign-in, an email behind Cloudflare Access. */
  owner: string | null;
  /** Sees every curator's runs (GET /api/runs?all=1); false on servers that do not say. */
  operator: boolean;
}

/** One of the caller's runs, as GET /api/runs lists them. */
export interface RunSummary {
  id: string;
  name: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
  queued?: boolean;
  /** Who sent it — only when an operator listed everyone's runs. */
  owner?: string;
}

/** What a waiting run is told as the line moves; position 0 means it is running. */
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
  id?: string;
  name?: string;
  since: number;
}

export interface QueueState {
  running: QueueEntry[];
  waiting: QueueEntry[];
  averageRunMs: number | null;
  maxConcurrentRuns: number;
}

export interface CaptureEvent {
  id: string;
  request: CaptureRequest;
  sha256: string;
  url: string;
}

export type ReviewEvent =
  | { check: string; phase: "request"; promptVersion: number; promptDigest: string; images: { id: string; label: string }[]; promptUrl: string }
  | { check: string; phase: "answer"; ok: true; answer: unknown; metadata: ReviewMetadata }
  | { check: string; phase: "answer"; ok: false; reason: string; metadata: ReviewMetadata };

/** Result as the server sends it: capture bytes replaced by URLs. */
export type WireResult = Omit<Result, "captures"> & { captures: (Omit<CaptureRecord, "bytes"> & { url: string })[] };

export type RunEvent =
  | { type: "check"; data: ProgressEvent }
  | { type: "gate"; data: { result: Result; passed: boolean | null } }
  /**
   * `views` is the planned capture count and `bodyShapes` the shapes rendered; older servers send the text alone.
   * A reference run first fetches the item: `kind: "fetch"` stages carry `done`/`total` files.
   */
  | { type: "stage"; data: { text: string; kind?: string; done?: number; total?: number; views?: number; bodyShapes?: string[] } }
  | { type: "queue"; data: QueuePosition }
  | { type: "capture"; data: CaptureEvent }
  | { type: "review"; data: ReviewEvent }
  /**
   * `gate` is the server's code run, so History can list every check; `zipUrl` is the kept upload
   * (`/api/runs/<id>/input.zip`). Runs older than the server that keeps them carry neither; reference runs have no zip
   * but carry `reference` (the URN or URL they were started from) so a run replayed from disk still reads as a fetch.
   */
  | { type: "done"; data: { result?: WireResult; gate?: Result; skipped?: boolean; message?: string; zipUrl?: string; reference?: string } }
  | { type: "error"; data: { message: string; zipUrl?: string } };

export type CheckRow = CheckResult & { findings: Finding[] };

/** One run as GET /api/runs/:id answers it; `owner` only when an operator asked. */
export interface RunDetail {
  id: string;
  name: string;
  done: boolean;
  events: { id: number; type: RunEvent["type"]; data: unknown }[];
  owner?: string;
}

export async function visualHealth(): Promise<VisualHealth | null> {
  try {
    const res = await fetch("/api/health", { headers: { accept: "application/json" } });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const body = (await res.json()) as { visual: VisualCapabilities; checks: string[]; owner?: string | null; operator?: boolean };
    return { visual: body.visual, checks: body.checks, owner: body.owner ?? null, operator: body.operator === true };
  } catch {
    return null;
  }
}

/**
 * Runs, newest first. `all` asks for every curator's runs (operators get an `owner` per run); a 403 falls back to the
 * caller's own. Fails soft: no server, not signed in, or an older server without the route → [].
 */
export async function listRuns(options: { all?: boolean } = {}): Promise<RunSummary[]> {
  try {
    const headers = { accept: "application/json" };
    let res = await fetch(options.all ? "/api/runs?all=1" : "/api/runs", { headers });
    if (res.status === 403 && options.all) res = await fetch("/api/runs", { headers });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return [];
    const body = (await res.json()) as { runs?: { id: string; name: string; startedAt: number | string; done: boolean; passed: boolean | null; queued?: boolean; owner?: unknown }[] };
    return (body.runs ?? [])
      .map(({ owner, ...run }) => {
        const startedAt = new Date(run.startedAt).getTime();
        return { ...run, startedAt: Number.isFinite(startedAt) ? startedAt : 0, ...(typeof owner === "string" && owner ? { owner } : {}) };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

/** A run by id, for the `?run=<id>` deep link. Throws a curator-facing sentence: unknown or another owner's run answers 404. */
export async function getRun(id: string): Promise<RunDetail> {
  let res: Response;
  try {
    res = await fetch(`/api/runs/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  } catch {
    throw new Error(runLoadMessage(null));
  }
  if (!res.ok || !res.headers.get("content-type")?.includes("json")) throw new Error(runLoadMessage(res.ok ? null : res.status));
  const body = (await res.json()) as Partial<RunDetail>;
  if (typeof body.id !== "string" || typeof body.name !== "string") throw new Error(runLoadMessage(null));
  return { id: body.id, name: body.name, done: body.done === true, events: body.events ?? [], ...(body.owner ? { owner: body.owner } : {}) };
}

/** What a run starts from: the zip's bytes, or a published item the server fetches itself. */
export type RunInput = Uint8Array | { reference: string };

export interface RunOptions {
  /** `false` renders only. */
  model: boolean;
  /** Ask the model even though the code checks failed. */
  standalone: boolean;
}

/** The request `startRun` sends, built apart from fetch so a test can read it. */
export function runRequest(input: RunInput, name: string, options: RunOptions): { url: string; init: RequestInit } {
  const query = new URLSearchParams({ ...(options.model ? {} : { model: "0" }), ...(options.standalone ? { standalone: "1" } : {}) }).toString();
  const url = `/api/runs${query ? `?${query}` : ""}`;
  if (input instanceof Uint8Array) {
    return {
      url,
      init: {
        method: "POST",
        // a plain ArrayBuffer: the body type fetch accepts everywhere
        body: input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer,
        headers: { "content-type": "application/zip", "x-file-name": encodeURIComponent(name) }
      }
    };
  }
  return { url, init: { method: "POST", body: JSON.stringify({ reference: input.reference }), headers: { "content-type": "application/json" } } };
}

export async function startRun(input: RunInput, name: string, options: RunOptions): Promise<{ id: string }> {
  const { url, init } = runRequest(input, name, options);
  const res = await fetch(url, init);
  const body = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !body.id) throw new Error(body.message ?? `The run server answered ${res.status}.`);
  return { id: body.id };
}

const EVENT_TYPES: RunEvent["type"][] = ["check", "gate", "stage", "queue", "capture", "review", "done", "error"];

/** Follows a run; the stream closes itself after `done` or `error`. Returns a stop function. */
export function followRun(id: string, onEvent: (event: RunEvent) => void): () => void {
  const source = new EventSource(`/api/runs/${id}/events`);
  let received = false;
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      // the native `error` Event shares a name with the server's `error` message; only messages carry data
      if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") return;
      received = true;
      const event = { type, data: JSON.parse(raw.data) } as RunEvent;
      onEvent(event);
      if (type === "done" || type === "error") source.close();
    });
  }
  source.onerror = () => {
    // EventSource reconnects on its own and closes itself after done/error; closed before any event means the server said no
    // (429 too many tabs, 404 not yours) with a body EventSource cannot read
    if (source.readyState !== EventSource.CLOSED || received) return;
    received = true;
    onEvent({ type: "error", data: { message: "Could not follow this run: too many tabs are open on it, or it is not yours." } });
  };
  return () => source.close();
}

/** Who is rendering and who is waiting; other curators' items are unnamed. Null when the server is away. */
export async function queueState(): Promise<QueueState | null> {
  try {
    const res = await fetch("/api/queue", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as QueueState;
  } catch {
    return null;
  }
}

export async function cancelRun(id: string): Promise<void> {
  await fetch(`/api/runs/${id}`, { method: "DELETE" }).catch(() => undefined);
}
