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
}

/** One of the caller's runs, as GET /api/runs lists them. */
export interface RunSummary {
  id: string;
  name: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
  queued?: boolean;
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
  | { type: "stage"; data: { text: string } }
  | { type: "queue"; data: QueuePosition }
  | { type: "capture"; data: CaptureEvent }
  | { type: "review"; data: ReviewEvent }
  /** `zipUrl` is the kept upload (`/api/runs/<id>/input.zip`); runs older than the server that keeps it carry none. */
  | { type: "done"; data: { result?: WireResult; skipped?: boolean; message?: string; zipUrl?: string } }
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
    const body = (await res.json()) as { visual: VisualCapabilities; checks: string[]; owner?: string | null };
    return { visual: body.visual, checks: body.checks, owner: body.owner ?? null };
  } catch {
    return null;
  }
}

/** The caller's runs, newest first. Fails soft: no server, not signed in, or an older server without the route → []. */
export async function listRuns(): Promise<RunSummary[]> {
  try {
    const res = await fetch("/api/runs", { headers: { accept: "application/json" } });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return [];
    const body = (await res.json()) as { runs?: { id: string; name: string; startedAt: number | string; done: boolean; passed: boolean | null }[] };
    return (body.runs ?? [])
      .map((run) => {
        const startedAt = new Date(run.startedAt).getTime();
        return { ...run, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
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

/** `model: false` renders only; `standalone` asks the model even though the code checks failed. */
export async function startRun(bytes: Uint8Array, name: string, options: { model: boolean; standalone: boolean }): Promise<{ id: string }> {
  const query = new URLSearchParams({ ...(options.model ? {} : { model: "0" }), ...(options.standalone ? { standalone: "1" } : {}) }).toString();
  const res = await fetch(`/api/runs${query ? `?${query}` : ""}`, {
    method: "POST",
    // a plain ArrayBuffer: the body type fetch accepts everywhere
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    headers: { "content-type": "application/zip", "x-file-name": encodeURIComponent(name) }
  });
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
      received = true;
      const event = { type, data: JSON.parse((raw as MessageEvent<string>).data) } as RunEvent;
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
