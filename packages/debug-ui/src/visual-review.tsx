import { useCallback, useEffect, useRef, useState } from "react";
import { checks as checkRegistry, docsUrl, sourceLinks, type CheckResult, type CheckStatus, type Finding, type Result } from "@dcl-regenesislabs/wearable-validator";
import { cancelRun, followRun, startRun, visualHealth, type CaptureEvent, type CheckRow, type ReviewEvent, type RunEvent, type VisualCapabilities, type WireResult } from "./api.js";

/**
 * Live view of a visual review: the run server renders the item, streams every screenshot as it lands, asks the
 * model, and the results land in the same rule table the code groups use. Shown only when a run server answers
 * /api/health (Vite dev proxies it); the static site never shows it. Screenshots and model calls always go
 * together: with code errors nothing runs until the creator presses the button.
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
const GLYPHS: Record<CheckStatus, string> = { passed: "✓", failed: "✕", warning: "!", skipped: "○", errored: "‼" };
const STATUS_LABELS: Record<CheckStatus, string> = { passed: "Passed", failed: "Needs fixing", warning: "Review", skipped: "Not checked", errored: "Check error" };
const MAX_CAPTURES = 12;

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
      if (event.data.result.group !== "rendering") return state;
      const rows = new Map(state.rows);
      rows.set(event.data.result.check, { ...event.data.result, findings: event.data.findings });
      return { ...state, rows };
    }
    case "gate":
      return { ...state, gate: event.data.result };
    case "stage":
      return { ...state, phase: "rendering", stage: event.data.text };
    case "capture": {
      const captures = state.captures.filter((capture) => capture.id !== event.data.id);
      return { ...state, phase: "rendering", stage: `Captured ${captionFor(event.data)}`, captures: [...captures, event.data] };
    }
    case "review": {
      const current = state.reviews[event.data.check] ?? {};
      const reviews = { ...state.reviews, [event.data.check]: event.data.phase === "request" ? { ...current, request: event.data } : { ...current, answer: event.data } };
      const title = checkRegistry[event.data.check]?.title ?? event.data.check;
      return event.data.phase === "request"
        ? { ...state, phase: "reviewing", stage: `Asking the model: ${title}`, reviews }
        : { ...state, stage: event.data.ok ? `Answer received: ${title}` : event.data.reason, reviews };
    }
    case "done":
      return { ...state, phase: "done", stage: event.data.message ?? "Finished", result: event.data.result, message: event.data.message };
    case "error":
      return { ...state, phase: "failed", stage: event.data.message, message: event.data.message };
  }
}

/** The "Your value" cell: what the item measures, or the model's one-word verdict with its finding count. */
function valueFor(row: CheckResult, review: RunState["reviews"][string] | undefined, findings: number): string | undefined {
  if (row.status === "skipped") return undefined;
  const answer = review?.answer;
  if (answer?.ok && answer.answer && typeof answer.answer === "object" && "verdict" in answer.answer) {
    const verdict = String((answer.answer as { verdict: unknown }).verdict);
    return findings ? `${verdict} · ${findings} finding${findings === 1 ? "" : "s"}` : verdict;
  }
  if (row.status === "errored") return undefined;
  return row.measured;
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

  const start = useCallback(async () => {
    if (!bytes) return;
    stop.current?.();
    setState({ ...EMPTY, phase: "starting", stage: "Uploading to the run server" });
    try {
      // the server may have been restarted with other flags since the panel mounted
      const health = await visualHealth();
      if (!health) throw new Error("The run server is not reachable. Start it with npm run serve -w wearable-validator-tools.");
      setCapabilities((current) => (JSON.stringify(current) === JSON.stringify(health.visual) ? current : health.visual));
      const { id } = await startRun(bytes, name, { model: true, standalone: codeResult?.passed !== true });
      setState((s) => ({ ...s, id, stage: "Running the code checks" }));
      stop.current = followRun(id, (event) => setState((s) => reduce(s, event)));
    } catch (error) {
      setState({ ...EMPTY, phase: "failed", stage: error instanceof Error ? error.message : "Could not start the run." });
    }
  }, [bytes, name, codeResult]);

  // clean code checks: render and ask right away. Code errors: the creator has things to fix first, so nothing
  // runs (no 60 s of screenshots nobody will use) until they press the button.
  const latestStart = useRef(start);
  latestStart.current = start;
  const serverKnown = capabilities !== null;
  useEffect(() => {
    setState(EMPTY);
    if (serverKnown && bytes && codeResult?.passed === true) void latestStart.current();
  }, [serverKnown, bytes, codeResult]);

  if (!capabilities || !bytes) return null;
  const running = state.phase !== "idle" && state.phase !== "done" && state.phase !== "failed";
  const rows: CheckResult[] = state.result?.checks ?? [...state.rows.values()];
  const allFindings: Finding[] = state.result?.findings ?? [...state.rows.values()].flatMap((row) => row.findings);
  const passed = rows.filter((row) => row.status === "passed").length;
  const modelKnown = capabilities.reviewer === "pi";

  return (
    <section className="group visual" aria-live="polite">
      <div className="group-head">
        <h2>Visual review</h2>
        <span className="tally">
          {rows.length > 0 ? `${passed}/${rows.length} passed · ` : ""}
          {capabilities.renderer ? "local renderer" : "no renderer"} · {modelKnown ? "two model calls per run" : "model: dry run"}
        </span>
      </div>
      <div className="visual-body">
        {state.phase === "idle" && (
          <div className="visual-actions">
            <button className="visual-btn" onClick={() => void start()}>Render and review anyway</button>
            <span className="visual-note">
              {codeResult?.passed === true ? "Waiting for the run server." : "The code checks did not pass. Fix those first, or render the item and ask the model anyway (about a minute and two model calls)."}
            </span>
          </div>
        )}

        {state.phase !== "idle" && (
          <div className={`visual-stage ${state.phase}`}>
            {running && <span className="spin-inline" aria-hidden="true" />}
            <span className="visual-stage-text">{state.stage}</span>
            {running && state.id && <button className="visual-cancel" onClick={() => void cancelRun(state.id!)}>Cancel</button>}
            {!running && <button className="visual-cancel" onClick={() => void start()}>Run again</button>}
          </div>
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
            {state.phase === "rendering" &&
              Array.from({ length: Math.max(0, MAX_CAPTURES - state.captures.length) }, (_, i) => (
                <figure className="visual-figure pending" key={`pending-${i}`} aria-hidden="true"><div className="visual-placeholder" /></figure>
              ))}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="rule-columns" aria-hidden="true">
            <span>Rule</span><span>Your value</span><span>Requirement</span><span>Status</span><span />
          </div>
          <div className="group-list">
            {rows.map((row) => {
              const def = checkRegistry[row.check];
              const review = state.reviews[row.check];
              const findings = allFindings.filter((finding) => finding.check === row.check);
              const notAsked = row.status === "skipped" && Boolean(def?.prompt);
              const status: CheckStatus = notAsked ? "skipped" : row.status;
              const value = valueFor(row, review, findings.length);
              const usage = review?.answer?.metadata.usage;
              return (
                <details className={`check ${status}`} key={row.check} open={findings.length > 0}>
                  <summary>
                    <span className="check-title">{def?.title ?? row.check}</span>
                    <span className={`rule-value${value === undefined ? " unavailable" : ""}`}>
                      <span className="mobile-label">Your value</span>
                      {value ?? (notAsked ? "Model not asked" : row.status === "errored" ? "No answer" : "Not measured")}
                    </span>
                    <span className="rule-requirement">
                      <span className="mobile-label">Requirement</span>
                      {def?.describe ?? "—"}
                    </span>
                    <span className={`rule-status ${status}`}>
                      <span aria-hidden="true">{GLYPHS[status]}</span> {notAsked ? "Not asked" : STATUS_LABELS[status]}
                    </span>
                    <span className="rule-chevron" aria-hidden="true">›</span>
                  </summary>
                  <div className="check-body">
                    {notAsked && <p className="skip-note">{modelKnown ? "The model was not asked for this run." : "The run server has no reviewer configured — start it with --auth."}</p>}
                    {row.status === "errored" && <p className="skip-note">no answer — {row.skipReason}</p>}
                    {row.status === "skipped" && !notAsked && <p className="skip-note">skipped — {row.skipReason}</p>}
                    {row.measured && !notAsked && <p className="explain">{row.measured}</p>}
                    {findings.map((f, i) => (
                      <div className={`finding ${f.severity}`} key={i}>
                        <p className="msg">{f.message}</p>
                        <div className="meta">
                          <span>{f.rule}</span>
                          {f.where && <span>{f.where}</span>}
                          {f.evidence?.map((ref) => (
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
                      </div>
                    ))}
                    {(row.status === "failed" || row.status === "warning") && def && (
                      <p className="fix-hint"><span className="fix-label">How to fix</span>{def.fix}</p>
                    )}
                    {review?.request && (
                      <div className="about-meta visual-model">
                        <span>prompt v{review.request.promptVersion} · {review.request.images.length} images</span>
                        <a href={review.request.promptUrl} target="_blank" rel="noreferrer">exact prompt and image order ↗</a>
                        {review.answer && <span>{review.answer.metadata.model}</span>}
                        {usage && <span>{usage.input.toLocaleString("en")} in · {usage.output.toLocaleString("en")} out · ${usage.cost.toFixed(3)}</span>}
                      </div>
                    )}
                    {review?.answer && (
                      <details className="about">
                        <summary>Raw answer</summary>
                        <pre className="visual-raw">{review.answer.ok ? JSON.stringify(review.answer.answer, null, 2) : review.answer.reason}</pre>
                      </details>
                    )}
                    {def && (
                      <details className="about">
                        <summary>About this check</summary>
                        <p className="explain">{def.explanation}</p>
                        <p className="how">{def.details}</p>
                        <div className="about-meta">
                          <span>{def.name} · {def.rule}</span>
                          <a href={docsUrl(def.name)} target="_blank" rel="noreferrer">docs ↗</a>
                          <a href={sourceLinks[def.name]} target="_blank" rel="noreferrer">source ↗</a>
                        </div>
                      </details>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
