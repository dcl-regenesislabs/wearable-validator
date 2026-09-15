import { useCallback, useEffect, useRef, useState } from "react";
import { checks as checkRegistry, type CheckStatus, type Finding, type Result } from "@dcl-regenesislabs/wearable-validator";
import { cancelRun, followRun, startRun, visualHealth, type CaptureEvent, type CheckRow, type ReviewEvent, type RunEvent, type VisualCapabilities, type WireResult } from "./api.js";

/**
 * Live view of a visual review: the run server renders the item, streams every screenshot as it lands,
 * then shows the prompt, the model's answer and the resulting findings. Shown only when a run server
 * answers /api/health (Vite dev proxies it); the static site never shows it.
 */

type Phase = "idle" | "starting" | "gate" | "rendering" | "reviewing" | "done" | "failed";

interface RunState {
  phase: Phase;
  id?: string;
  stage: string;
  gate?: Result;
  captures: CaptureEvent[];
  reviews: Record<string, { request?: Extract<ReviewEvent, { phase: "request" }>; answer?: Extract<ReviewEvent, { phase: "answer" }> }>;
  rows: Map<string, CheckRow>;
  result?: WireResult;
  message?: string;
}

const EMPTY: RunState = { phase: "idle", stage: "", captures: [], reviews: {}, rows: new Map() };
const STATUS_LABELS: Record<CheckStatus, string> = { passed: "Passed", failed: "Needs fixing", warning: "Review", skipped: "Not checked", errored: "Check error" };

/** "BaseMale · avatar · 90°" from a capture request — the same words the model was given. */
function captionFor(capture: CaptureEvent): string {
  const { request } = capture;
  const shape = request.bodyShape.split(":").pop() ?? request.bodyShape;
  const time = request.timeFraction === undefined ? "" : ` · t=${request.timeFraction}`;
  return `${shape} · ${request.view} · ${request.azimuthDegrees}°${time}`;
}

function reduce(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "check": {
      if (event.data.type === "check-started") return state.phase === "starting" || state.phase === "gate" ? { ...state, phase: "gate", stage: `Checking ${event.data.check}` } : state;
      const rows = new Map(state.rows);
      rows.set(event.data.result.check, { ...event.data.result, findings: event.data.findings });
      return { ...state, rows };
    }
    case "gate":
      return { ...state, gate: event.data.result, rows: new Map() };
    case "stage":
      return { ...state, phase: "rendering", stage: event.data.text };
    case "capture": {
      // a view rendered again replaces the reused one with the same id
      const captures = state.captures.filter((capture) => capture.id !== event.data.id);
      return { ...state, phase: "rendering", stage: `Captured ${captionFor(event.data)}`, captures: [...captures, event.data] };
    }
    case "review": {
      const current = state.reviews[event.data.check] ?? {};
      const reviews = { ...state.reviews, [event.data.check]: event.data.phase === "request" ? { ...current, request: event.data } : { ...current, answer: event.data } };
      return event.data.phase === "request"
        ? { ...state, phase: "reviewing", stage: `Asking the model about ${event.data.check}`, reviews }
        : { ...state, stage: event.data.ok ? `Answer received for ${event.data.check}` : event.data.reason, reviews };
    }
    case "done":
      return { ...state, phase: "done", stage: event.data.message ?? "Finished", result: event.data.result, message: event.data.message };
    case "error":
      return { ...state, phase: "failed", stage: event.data.message, message: event.data.message };
  }
}

export function VisualReview({ bytes, name, codeResult }: { bytes?: Uint8Array; name: string; codeResult: Result | null }) {
  const [capabilities, setCapabilities] = useState<VisualCapabilities | null>(null);
  const [state, setState] = useState<RunState>(EMPTY);
  const [highlight, setHighlight] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    void visualHealth().then((health) => alive && setCapabilities(health?.visual ?? null));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => () => stop.current?.(), []);

  const start = useCallback(async (askModel: boolean) => {
    if (!bytes) return;
    stop.current?.();
    setState({ ...EMPTY, phase: "starting", stage: "Uploading to the run server" });
    try {
      // the server may have been restarted with other flags since the panel mounted
      const health = await visualHealth();
      if (!health) throw new Error("The run server is not reachable. Start it with npm run serve -w wearable-validator-tools.");
      setCapabilities((current) => (JSON.stringify(current) === JSON.stringify(health.visual) ? current : health.visual));
      const { id } = await startRun(bytes, name, { model: askModel, standalone: askModel && codeResult?.passed !== true });
      setState((s) => ({ ...s, id, stage: "Running the code checks" }));
      stop.current = followRun(id, (event) => setState((s) => reduce(s, event)));
    } catch (error) {
      setState({ ...EMPTY, phase: "failed", stage: error instanceof Error ? error.message : "Could not start the run." });
    }
  }, [bytes, name, codeResult]);

  // a run server is there and a zip is loaded: the photos are always taken. The model is asked right away only
  // when the code checks passed; with errors the creator has things to fix first, so that waits for a click.
  const latestStart = useRef(start);
  latestStart.current = start;
  const serverKnown = capabilities !== null;
  useEffect(() => {
    setState(EMPTY);
    if (serverKnown && bytes && codeResult) void latestStart.current(codeResult.passed === true);
  }, [serverKnown, bytes, codeResult]);
  const modelAsked = Object.keys(state.reviews).length > 0;

  if (!capabilities || !bytes) return null;
  const running = state.phase !== "idle" && state.phase !== "done" && state.phase !== "failed";
  const rows = state.result?.checks ?? [];
  const intro = checkRegistry["thumbnail-honesty"];

  return (
    <section className="group visual" aria-live="polite">
      <div className="group-head">
        <h2>Visual review</h2>
        <span className="tally">
          {capabilities.renderer ? "local renderer" : "no renderer"} · {capabilities.reviewer === "pi" ? "one model call per run" : "model: dry run"}
        </span>
      </div>
      <div className="visual-body">
        {state.phase !== "idle" && (
          <div className={`visual-stage ${state.phase}`}>
            {running && <span className="spin-inline" aria-hidden="true" />}
            {rows.map((row) => {
              const notAsked = (row.status === "skipped" || row.status === "errored") && Boolean(checkRegistry[row.check]?.prompt) && (!modelAsked || capabilities.reviewer !== "pi");
              return (
                <span key={row.check} className={`rule-status ${notAsked ? "skipped" : row.status}`} title={row.check}>
                  {checkRegistry[row.check]?.title ?? row.check}: {notAsked ? "model not asked" : STATUS_LABELS[row.status]}
                </span>
              );
            })}
            <span className="visual-stage-text">{state.stage}</span>
            {running && state.id && (
              <button className="visual-cancel" onClick={() => void cancelRun(state.id!)}>Cancel</button>
            )}
            {!running && !modelAsked && codeResult?.passed !== true && (
              <button className="visual-btn" onClick={() => void start(true)}>Ask the model anyway</button>
            )}
            {!running && (
              <button className="visual-cancel" onClick={() => void start(modelAsked || codeResult?.passed === true)}>Run again</button>
            )}
          </div>
        )}

        {state.gate && state.gate.passed !== true && state.phase !== "idle" && (
          <p className="visual-note">Server-side code checks: {state.gate.summary.errors} errors, {state.gate.summary.warnings} warnings — fix those first; the model is only asked when you press the button.</p>
        )}

        {(state.captures.length > 0 || state.phase === "rendering") && (
          <div className="visual-grid">
            {state.id && (
              <figure className={`visual-figure${highlight === "thumbnail" ? " lit" : ""}`} id="capture-thumbnail">
                <img src={`/api/runs/${state.id}/thumbnail.png`} alt="original thumbnail" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <figcaption>thumbnail (original)</figcaption>
              </figure>
            )}
            {state.captures.map((capture) => (
              <figure className={`visual-figure${highlight === capture.id ? " lit" : ""}`} key={capture.id} id={`capture-${capture.id}`}>
                <img src={`${capture.url}?v=${capture.sha256.slice(0, 8)}`} alt={captionFor(capture)} />
                <figcaption>{captionFor(capture)}</figcaption>
              </figure>
            ))}
            {state.phase === "rendering" && state.captures.length < 12 && Array.from({ length: Math.max(0, 12 - state.captures.length) }, (_, i) => (
              <figure className="visual-figure pending" key={`pending-${i}`} aria-hidden="true"><div className="visual-placeholder" /></figure>
            ))}
          </div>
        )}

        {Object.entries(state.reviews).map(([check, review]) => {
          const row = rows.find((candidate) => candidate.check === check);
          const findings: Finding[] = (state.result?.findings ?? []).filter((finding) => finding.check === check);
          const def = checkRegistry[check];
          const usage = review.answer?.metadata.usage;
          return (
            <div className="visual-review" key={check}>
              <div className="visual-review-head">
                <span className="eui-overline">{def?.title ?? check} · prompt v{review.request?.promptVersion}</span>
                {review.request && <a href={review.request.promptUrl} target="_blank" rel="noreferrer">read the exact prompt and image order ↗</a>}
                {review.request && <span className="visual-mono">{review.request.images.length} images · digest {review.request.promptDigest.slice(0, 8)}…</span>}
              </div>
              {review.answer && (
                <div className="visual-answer">
                  <span className="eui-overline">answer · {review.answer.metadata.model}</span>
                  {review.answer.ok ? <pre>{JSON.stringify(review.answer.answer, null, 2)}</pre> : <p className="skip-note">{review.answer.reason}</p>}
                  {usage && (
                    <span className="visual-mono">
                      {usage.input.toLocaleString("en")} in · {usage.output.toLocaleString("en")} out · ${usage.cost.toFixed(3)}
                    </span>
                  )}
                </div>
              )}
              {row && (
                <div className="check-body visual-result">
                  {row.measured && <p className="explain">{row.measured}</p>}
                  {row.skipReason && <p className="skip-note">{row.status === "skipped" ? "skipped" : "check error"} — {row.skipReason}</p>}
                  {findings.map((f, i) => (
                    <div className={`finding ${f.severity}`} key={i}>
                      <p className="msg">{f.message} <span className="visual-mono">({f.rule})</span></p>
                      {f.evidence && (
                        <div className="meta">
                          {f.evidence.map((ref) => (
                            <button
                              key={ref.captureId}
                              className="evidence-chip"
                              onMouseEnter={() => setHighlight(ref.captureId)}
                              onMouseLeave={() => setHighlight(null)}
                              onClick={() => document.getElementById(`capture-${ref.captureId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                            >
                              {ref.captureId}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {(row.status === "failed" || row.status === "warning") && def && (
                    <p className="fix-hint"><span className="fix-label">How to fix</span>{def.fix}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {rows.filter((row) => !state.reviews[row.check]).map((row) => (
          <div className="visual-result check-body" key={row.check}>
            <p className="explain"><b>{checkRegistry[row.check]?.title ?? row.check}</b> — {row.measured ?? row.skipReason}</p>
            {(state.result?.findings ?? []).filter((finding) => finding.check === row.check).map((f, i) => (
              <div className={`finding ${f.severity}`} key={i}><p className="msg">{f.message}</p></div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
