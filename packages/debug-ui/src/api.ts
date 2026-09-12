/**
 * The run server's API (tools/src/serve.ts): start a run, follow it over Server-Sent Events.
 * In dev, Vite proxies /api to it; on the static site there is no server and every call fails soft.
 */
import type { CaptureRequest, CheckResult, Finding, ProgressEvent, Result, ReviewMetadata } from "@dcl-regenesislabs/wearable-validator";

export interface VisualCapabilities {
  renderer: boolean;
  reviewer: "pi" | "dry-run" | "none";
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
export type WireResult = Omit<Result, "captures"> & { captures: { request: CaptureRequest; url: string }[] };

export type RunEvent =
  | { type: "check"; data: ProgressEvent }
  | { type: "gate"; data: { result: Result; passed: boolean | null } }
  | { type: "stage"; data: { text: string } }
  | { type: "capture"; data: CaptureEvent }
  | { type: "review"; data: ReviewEvent }
  | { type: "done"; data: { result?: WireResult; skipped?: boolean; message?: string } }
  | { type: "error"; data: { message: string } };

export type CheckRow = CheckResult & { findings: Finding[] };

export async function visualHealth(): Promise<{ visual: VisualCapabilities; checks: string[] } | null> {
  try {
    const res = await fetch("/api/health", { headers: { accept: "application/json" } });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    return (await res.json()) as { visual: VisualCapabilities; checks: string[] };
  } catch {
    return null;
  }
}

export async function startRun(bytes: Uint8Array, name: string, standalone: boolean): Promise<{ id: string }> {
  const res = await fetch(`/api/runs${standalone ? "?standalone=1" : ""}`, {
    method: "POST",
    // a plain ArrayBuffer: the body type fetch accepts everywhere
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    headers: { "content-type": "application/zip", "x-file-name": encodeURIComponent(name) }
  });
  const body = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !body.id) throw new Error(body.message ?? `The run server answered ${res.status}.`);
  return { id: body.id };
}

const EVENT_TYPES: RunEvent["type"][] = ["check", "gate", "stage", "capture", "review", "done", "error"];

/** Follows a run; the stream closes itself after `done` or `error`. Returns a stop function. */
export function followRun(id: string, onEvent: (event: RunEvent) => void): () => void {
  const source = new EventSource(`/api/runs/${id}/events`);
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      const event = { type, data: JSON.parse((raw as MessageEvent<string>).data) } as RunEvent;
      onEvent(event);
      if (type === "done" || type === "error") source.close();
    });
  }
  source.onerror = () => {
    // EventSource reconnects on its own; a closed stream after done/error is not an error
    if (source.readyState === EventSource.CLOSED) return;
  };
  return () => source.close();
}

export async function cancelRun(id: string): Promise<void> {
  await fetch(`/api/runs/${id}`, { method: "DELETE" }).catch(() => undefined);
}
