import { useRef, useState, type ReactNode } from "react";
import { checks as checkRegistry, docsUrl, manifest, sourceLinks, type CheckResult, type CheckStatus } from "@dcl-regenesislabs/wearable-validator";
import type { CaptureEvent } from "./api.js";
import { GROUP_LABELS, isRunning, visualRows, visualStepsOf, type Review, type VisualPhase, type VisualState } from "./progress.js";
import { PendingCaptures, Stepper } from "./stepper.js";
import { FindingCard, RuleColumns, Spinner, StatusChip, filterStatuses } from "./rules.js";

/**
 * One visual review on screen — the item being validated or a run opened from History: the stepper with its
 * actions, then the Rendering group (photos and rule rows) once the renderer has something to show.
 */

const THUMBNAIL_RETRIES = 3;
const THUMBNAIL_RETRY_MS = 4000;

const PHASE_WORDS: Record<VisualPhase, string> = {
  idle: "Not started",
  uploading: "Uploading",
  gate: "Checking the code",
  queued: "Waiting in line",
  rendering: "Rendering",
  reviewing: "Asking the model",
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled"
};

/** "BaseMale · avatar · 90°" from a capture request — the same words the model was given. */
export function captionFor(capture: CaptureEvent): string {
  const { request } = capture;
  const shape = request.bodyShape.split(":").pop() ?? request.bodyShape;
  const time = request.timeFraction === undefined ? "" : ` · t=${request.timeFraction}`;
  const pose = request.pose ? ` · ${request.pose}` : "";
  return `${shape} · ${request.view}${pose} · ${request.azimuthDegrees}°${time}`;
}

/** The "Your value" cell: what the item measures, or the model's one-word verdict with its finding count. */
function valueFor(row: CheckResult, review: Review | undefined, findings: number): string | undefined {
  if (row.status === "skipped") return undefined;
  const answer = review?.answer;
  if (answer?.ok && answer.answer && typeof answer.answer === "object" && "verdict" in answer.answer) {
    const verdict = String((answer.answer as { verdict: unknown }).verdict);
    return findings ? `${verdict} · ${findings} finding${findings === 1 ? "" : "s"}` : verdict;
  }
  if (row.status === "errored") return undefined;
  return row.measured;
}

export interface RunViewProps {
  state: VisualState;
  aiChecks: string[];
  /** The server has a real reviewer; otherwise a skipped model row explains why. */
  modelKnown: boolean;
  /** Result filter key from the Validate toolbar; absent shows every row. */
  filter?: string;
  onCancel?: () => void;
  onRunAgain?: () => void;
  /** What sits under the stepper before the run starts (the Validate tab's gate button). */
  gate?: ReactNode;
}

export function RunView({ state, aiChecks, modelKnown, filter, onCancel, onRunAgain, gate }: RunViewProps) {
  const running = isRunning(state.phase);
  const steps = visualStepsOf(state, aiChecks);
  const rows = visualRows(state);
  const showGroup = rows.length > 0 || state.captures.length > 0 || state.phase === "rendering" || state.phase === "reviewing";
  return (
    <>
      <section className={`eui-panel visual-card ${state.phase}`}>
        <div className="eui-panel-head">
          <div className="eui-head-text">
            <span className="eui-overline">Visual review</span>
            <span className="eui-title">{PHASE_WORDS[state.phase]}</span>
          </div>
          <div className="eui-head-actions">
            {running && onCancel && <button type="button" className="eui-ds-btn ghost sm" onClick={onCancel} disabled={state.cancelling}>{state.cancelling ? "Cancelling" : "Cancel"}</button>}
            {!running && state.phase !== "idle" && onRunAgain && <button type="button" className="eui-ds-btn secondary sm" onClick={onRunAgain}>Run again</button>}
          </div>
        </div>
        <div className="eui-panel-body visual-body">
          {state.phase !== "idle" ? (
            <Stepper steps={steps} label="Visual review progress" />
          ) : (
            gate ?? (
              <p className="loading-hint" role="status">
                <Spinner size="sm" decorative /> Loading the run
              </p>
            )
          )}
        </div>
      </section>
      {showGroup && <RenderingGroup state={state} rows={rows} modelKnown={modelKnown} filter={filter} />}
    </>
  );
}

function RenderingGroup({ state, rows, modelKnown, filter }: { state: VisualState; rows: ReturnType<typeof visualRows>; modelKnown: boolean; filter?: string }) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const reveal = (captureId: string) =>
    root.current?.querySelector(`[data-capture="${captureId}"]`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  const statuses = filter ? filterStatuses(filter) : null;
  const shown = statuses ? rows.filter((row) => statuses.includes(row.status)) : rows;
  const passed = rows.filter((row) => row.status === "passed").length;
  const rendering = state.phase === "rendering";
  const pending = rendering ? (state.views || manifest.rendering.maxCaptures) - state.captures.length : 0;
  const bodyShapes = state.bodyShapes?.length ?? (new Set(state.captures.map((capture) => capture.request.bodyShape)).size || undefined);
  return (
    <section ref={root} className="group rendering" aria-busy={rendering || undefined}>
      <div className="group-head">
        <h2>{GROUP_LABELS.rendering}</h2>
        <span className="tally">
          {rows.length > 0 && <>{passed}/{rows.length} passed · </>}
          {state.captures.length} {state.captures.length === 1 ? "view" : "views"}
          {bodyShapes !== undefined && <> · {bodyShapes} body {bodyShapes === 1 ? "shape" : "shapes"}</>}
        </span>
      </div>
      {(state.captures.length > 0 || rendering) && (
        <div className="visual-grid">
          {state.id && (
            <figure className={`visual-figure${highlight === "thumbnail" ? " lit" : ""}`} data-capture="thumbnail">
              <img
                src={`/api/runs/${state.id}/thumbnail.png`}
                alt="original thumbnail"
                // an item with no thumbnail 404s for good; a run that has not written it yet answers on the retry
                onError={(event) => {
                  const image = event.target as HTMLImageElement & { dataset: { tries?: string } };
                  const tries = Number(image.dataset.tries ?? 0);
                  image.style.visibility = "hidden";
                  if (tries >= THUMBNAIL_RETRIES) return;
                  image.dataset.tries = String(tries + 1);
                  setTimeout(() => {
                    image.style.visibility = "visible";
                    image.src = `/api/runs/${state.id}/thumbnail.png?try=${tries + 1}`;
                  }, THUMBNAIL_RETRY_MS);
                }}
              />
              <figcaption>thumbnail (original)</figcaption>
            </figure>
          )}
          {state.captures.map((capture) => (
            <figure className={`visual-figure${highlight === capture.id ? " lit" : ""}`} key={capture.id} data-capture={capture.id}>
              <img src={`${capture.url}?v=${capture.sha256.slice(0, 8)}`} alt={captionFor(capture)} />
              <figcaption>{captionFor(capture)}</figcaption>
            </figure>
          ))}
          <PendingCaptures count={pending} />
        </div>
      )}
      {rows.length > 0 && shown.length === 0 && <p className="empty-rows" role="status">No rendering rules in this view.</p>}
      {shown.length > 0 && (
        <>
          <RuleColumns />
          <div className="group-list">
            {shown.map((row) => {
              const def = checkRegistry[row.check];
              const review = state.reviews[row.check];
              const notAsked = row.status === "skipped" && Boolean(def?.prompt);
              const status: CheckStatus = notAsked ? "skipped" : row.status;
              const value = valueFor(row, review, row.findings.length);
              const usage = review?.answer?.metadata.usage;
              return (
                <details className={`check ${status}`} key={row.check} open={row.findings.length > 0}>
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
                    <StatusChip status={status} label={notAsked ? "Not asked" : undefined} />
                    <span className="rule-chevron" aria-hidden="true">›</span>
                  </summary>
                  <div className="check-body">
                    {notAsked && <p className="skip-note">{modelKnown ? "The model was not asked for this run." : "The run server has no reviewer configured — start it with ANTHROPIC_OAUTH_SETUP_TOKEN."}</p>}
                    {row.status === "errored" && <p className="skip-note">no answer — {row.skipReason}</p>}
                    {row.status === "skipped" && !notAsked && <p className="skip-note">skipped — {row.skipReason}</p>}
                    {row.measured && !notAsked && <p className="explain">{row.measured}</p>}
                    {row.findings.map((finding, index) => (
                      <FindingCard finding={finding} key={index}>
                        <span>{finding.rule}</span>
                        {finding.evidence?.map((ref) => (
                          <button
                            type="button"
                            key={ref.captureId}
                            className="evidence-chip"
                            onMouseEnter={() => setHighlight(ref.captureId)}
                            onMouseLeave={() => setHighlight(null)}
                            onFocus={() => setHighlight(ref.captureId)}
                            onBlur={() => setHighlight(null)}
                            onClick={() => reveal(ref.captureId)}
                          >
                            {ref.captureId}
                          </button>
                        ))}
                      </FindingCard>
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

