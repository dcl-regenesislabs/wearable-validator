import { useCallback, useEffect, useRef, useState } from "react";
import { checks as checkRegistry, docsUrl, sourceLinks, type CheckResult, type CheckStatus, type Finding, type Result } from "@dcl-regenesislabs/wearable-validator";
import { cancelRun, followRun, listRuns, queueState, startRun, visualHealth, type CaptureEvent, type CheckRow, type QueuePosition, type QueueState, type ReviewEvent, type RunEvent, type RunSummary, type VisualCapabilities, type WireResult } from "./api.js";
import { runChip } from "./run-list.js";

/**
 * Live view of a visual review: the run server renders the item, streams every screenshot as it lands, asks the
 * model, and the results land in the same rule table the code groups use. Shown only when a run server answers
 * /api/health (Vite dev proxies it); the static site never shows it. Screenshots and model calls always go
 * together: with code errors nothing runs until the creator presses the button.
 */

type Phase = "idle" | "starting" | "gate" | "queued" | "rendering" | "reviewing" | "done" | "failed";

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
  queue?: QueuePosition;
}

const EMPTY: RunState = { phase: "idle", stage: "", captures: [], reviews: {}, rows: new Map() };
const GLYPHS: Record<CheckStatus, string> = { passed: "✓", failed: "✕", warning: "!", skipped: "○", errored: "‼" };
const STATUS_LABELS: Record<CheckStatus, string> = { passed: "Passed", failed: "Needs fixing", warning: "Review", skipped: "Not checked", errored: "Check error" };
const MAX_CAPTURES = 12;
const MAX_LISTED_RUNS = 20;
const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];
const QUEUE_POLL_MS = 4000;
const MAX_LISTED_QUEUE = 6;

/** "about 2 min", "under a minute": the wait estimate the server derives from its last renders. */
function waitText(etaMs: number | null): string {
  if (etaMs === null) return "";
  if (etaMs < 60_000) return " · under a minute";
  return ` · about ${Math.max(1, Math.round(etaMs / 60_000))} min`;
}

/** "40 s" / "3 min" for how long an item has been in its state. */
function elapsedText(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** "3 minutes ago", "yesterday": the largest unit that fits, "now" under a minute. */
function relativeTime(startedAt: number, now: number): string {
  if (startedAt <= 0) return "earlier";
  const elapsed = now - startedAt;
  for (const [unit, ms] of TIME_UNITS) {
    if (elapsed >= ms) return RELATIVE_TIME.format(-Math.round(elapsed / ms), unit);
  }
  return RELATIVE_TIME.format(0, "second");
}

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
    case "queue": {
      const place = event.data;
      if (place.position === 0) return { ...state, phase: "rendering", stage: "Your turn: starting the render", queue: place };
      const ahead = place.ahead === 1 ? "1 item ahead of you" : `${place.ahead} items ahead of you`;
      return { ...state, phase: "queued", stage: `Waiting in line: ${ahead}${waitText(place.etaMs)}`, queue: place };
    }
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
    case "done": {
      // a finished run loaded from disk replays only this event, so its photos arrive inside the result
      const known = new Set(state.captures.map((capture) => capture.id));
      const replayed = (event.data.result?.captures ?? [])
        .filter(({ request }) => !known.has(request.id))
        .map(({ request, sha256, url }): CaptureEvent => ({ id: request.id, request, sha256, url }));
      return { ...state, phase: "done", stage: event.data.message ?? "Finished", captures: [...state.captures, ...replayed], result: event.data.result, message: event.data.message };
    }
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


/** One run on screen: its stage line, photos and rule rows. The live run and any run opened from the list share it. */
function RunView({ state, modelKnown, onCancel, onRunAgain }: { state: RunState; modelKnown: boolean; onCancel?: () => void; onRunAgain?: () => void }) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const running = state.phase !== "idle" && state.phase !== "done" && state.phase !== "failed";
  // a run that stopped at the code gate carries the code result: only the rendering rows belong in this panel
  const visual = (check: string) => checkRegistry[check]?.group === "rendering";
  const rows: CheckResult[] = (state.result?.checks ?? [...state.rows.values()]).filter((row) => visual(row.check));
  const allFindings: Finding[] = (state.result?.findings ?? [...state.rows.values()].flatMap((row) => row.findings)).filter((finding) => visual(finding.check));
  const reveal = (captureId: string) => root.current?.querySelector(`[data-capture="${captureId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <div ref={root} className="visual-run">
      <div className="visual-body">
        {state.phase !== "idle" && (
          <div className={`visual-stage ${state.phase}`}>
            {running && <span className="spin-inline" aria-hidden="true" />}
            <span className="visual-stage-text">{state.stage}</span>
            {running && onCancel && <button className="visual-cancel" onClick={onCancel}>Cancel</button>}
            {!running && onRunAgain && <button className="visual-cancel" onClick={onRunAgain}>Run again</button>}
          </div>
        )}

        {(state.captures.length > 0 || state.phase === "rendering") && (
          <div className="visual-grid">
            {state.id && (
              <figure className={`visual-figure${highlight === "thumbnail" ? " lit" : ""}`} data-capture="thumbnail">
                <img src={`/api/runs/${state.id}/thumbnail.png`} alt="original thumbnail" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <figcaption>thumbnail (original)</figcaption>
              </figure>
            )}
            {state.captures.map((capture) => (
              <figure className={`visual-figure${highlight === capture.id ? " lit" : ""}`} key={capture.id} data-capture={capture.id}>
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
                    {notAsked && <p className="skip-note">{modelKnown ? "The model was not asked for this run." : "The run server has no reviewer configured — start it with ANTHROPIC_OAUTH_SETUP_TOKEN."}</p>}
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
                              onClick={() => reveal(ref.captureId)}
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
    </div>
  );
}

/** An earlier run opened from the list, on top of whatever is running: its stream replays every event, nothing is uploaded. */
function RunModal({ run, modelKnown, onClose }: { run: RunSummary; modelKnown: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<RunState>({ ...EMPTY, phase: "starting", id: run.id, stage: `Loading ${run.name}` });
  useEffect(() => {
    dialog.current?.showModal();
    const stop = followRun(run.id, (event) => setState((s) => reduce(s, event)));
    return stop;
  }, [run.id]);
  return (
    <dialog ref={dialog} className="visual-modal" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="visual-modal-head">
        <span className="visual-modal-title">{run.name}</span>
        <span className="visual-modal-time">{new Date(run.startedAt).toLocaleString("en")}</span>
        <button className="visual-cancel" onClick={onClose}>Close</button>
      </div>
      <RunView state={state} modelKnown={modelKnown} onCancel={() => void cancelRun(run.id)} />
    </dialog>
  );
}

export function VisualReview({ bytes, name, codeResult }: { bytes?: Uint8Array; name: string; codeResult: Result | null }) {
  const [capabilities, setCapabilities] = useState<VisualCapabilities | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [state, setState] = useState<RunState>(EMPTY);
  const [opened, setOpened] = useState<RunSummary | null>(null);
  const stop = useRef<(() => void) | null>(null);

  const refreshRuns = useCallback(() => {
    void listRuns().then((list) => {
      setRuns(list.slice(0, MAX_LISTED_RUNS));
      setNow(Date.now());
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void visualHealth().then((health) => {
      if (!alive) return;
      setCapabilities(health?.visual ?? null);
      setOwner(health?.owner ?? null);
      if (health) refreshRuns();
    });
    return () => {
      alive = false;
    };
  }, [refreshRuns]);
  useEffect(() => () => stop.current?.(), []);

  // keep "3 minutes ago" honest while the list is on screen
  useEffect(() => {
    if (runs.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [runs.length]);

  // the line is shared by every curator: poll it while the server is known, so the wait is visible before dropping a file
  const [queue, setQueue] = useState<QueueState | null>(null);
  const serverKnown = capabilities !== null;
  useEffect(() => {
    if (!serverKnown) return;
    let alive = true;
    const read = () => void queueState().then((q) => {
      if (!alive) return;
      setQueue(q);
      setNow(Date.now());
    });
    read();
    const timer = setInterval(read, QUEUE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [serverKnown]);

  const start = useCallback(async () => {
    if (!bytes) return;
    stop.current?.();
    setState({ ...EMPTY, phase: "starting", stage: "Uploading to the run server" });
    try {
      // the server may have been restarted with other flags since the panel mounted
      const health = await visualHealth();
      if (!health) throw new Error("The run server is not reachable. Start it with npm run serve at the repo root.");
      setCapabilities((current) => (JSON.stringify(current) === JSON.stringify(health.visual) ? current : health.visual));
      setOwner(health.owner);
      const { id } = await startRun(bytes, name, { model: true, standalone: codeResult?.passed !== true });
      setState((s) => ({ ...s, id, stage: "Running the code checks" }));
      stop.current = followRun(id, (event) => setState((s) => reduce(s, event)));
      refreshRuns();
    } catch (error) {
      setState({ ...EMPTY, phase: "failed", stage: error instanceof Error ? error.message : "Could not start the run." });
    }
  }, [bytes, name, codeResult, refreshRuns]);

  /** Another run opens on top; the one on screen keeps streaming underneath. The run on screen itself is not reopened. */
  const follow = useCallback((run: RunSummary) => {
    if (run.id === state.id) return;
    setOpened(run);
  }, [state.id]);

  // the list is a mirror of the server: re-read it whenever our run changes state (queued, running, done, failed)
  const phase = state.phase;
  useEffect(() => {
    if (phase === "idle" || phase === "starting") return;
    refreshRuns();
    void queueState().then((q) => q && setQueue(q));
  }, [phase, refreshRuns]);

  // clean code checks: render and ask right away. Code errors: the creator has things to fix first, so nothing
  // runs (no 60 s of screenshots nobody will use) until they press the button.
  const latestStart = useRef(start);
  latestStart.current = start;
  useEffect(() => {
    setState(EMPTY);
    if (serverKnown && bytes && codeResult?.passed === true) void latestStart.current();
  }, [serverKnown, bytes, codeResult]);

  if (!capabilities || !bytes) return null;
  const rows: CheckResult[] = (state.result?.checks ?? [...state.rows.values()]).filter((row) => checkRegistry[row.check]?.group === "rendering");
  const passed = rows.filter((row) => row.status === "passed").length;
  const modelKnown = capabilities.reviewer === "pi";

  return (
    <section className="group visual" aria-live="polite">
      <div className="group-head">
        <h2>Visual review</h2>
        <span className="tally">
          {rows.length > 0 ? `${passed}/${rows.length} passed · ` : ""}
          {capabilities.renderer ? "local renderer" : "no renderer"} · {modelKnown ? "two model calls per run" : "model: dry run"}
          {owner && owner !== "local" ? ` · Signed in as ${owner}` : ""}
        </span>
      </div>
      {queue && (queue.running.length > 0 || queue.waiting.length > 0) && (
        <div className="visual-queue" aria-label="Server activity">
          <span className="visual-queue-head">Rendering now</span>
          <ul className="visual-queue-list">
            {queue.running.map((entry, i) => (
              <li key={entry.id ?? `running-${i}`} className={entry.mine ? "mine" : ""}>
                <span className="spin-inline" aria-hidden="true" />
                <span className="visual-queue-name">{entry.mine ? entry.name : "another curator's item"}</span>
                {entry.mine && <span className="visual-queue-you">you</span>}
                <span className="visual-queue-time">{elapsedText(entry.since, now)}</span>
              </li>
            ))}
            {queue.running.length === 0 && <li className="visual-queue-empty">nothing, the next item starts right away</li>}
          </ul>
          {queue.waiting.length > 0 && (
            <>
              <span className="visual-queue-head">Waiting line · {queue.waiting.length}{waitText(queue.averageRunMs === null ? null : queue.waiting.length * queue.averageRunMs / queue.maxConcurrentRuns)}</span>
              <ol className="visual-queue-list">
                {queue.waiting.slice(0, MAX_LISTED_QUEUE).map((entry, i) => (
                  <li key={entry.id ?? `waiting-${i}`} className={entry.mine ? "mine" : ""}>
                    <span className="visual-queue-pos">#{entry.position}</span>
                    <span className="visual-queue-name">{entry.mine ? entry.name : "another curator's item"}</span>
                    {entry.mine && <span className="visual-queue-you">you</span>}
                    <span className="visual-queue-time">waiting {elapsedText(entry.since, now)}</span>
                  </li>
                ))}
                {queue.waiting.length > MAX_LISTED_QUEUE && <li className="visual-queue-empty">and {queue.waiting.length - MAX_LISTED_QUEUE} more</li>}
              </ol>
            </>
          )}
        </div>
      )}
      {runs.length > 0 && (
        <nav className="visual-runs" aria-label="Your runs">
          <span className="visual-runs-head">Your runs</span>
          <ul className="visual-runs-list">
            {runs.map((run) => {
              const chip = runChip(run);
              return (
                <li key={run.id}>
                  <button className="visual-runs-row" aria-current={state.id === run.id ? "true" : undefined} onClick={() => follow(run)}>
                    <span className="visual-runs-name">{run.name}</span>
                    <time className="visual-runs-time" dateTime={run.startedAt > 0 ? new Date(run.startedAt).toISOString() : undefined}>{relativeTime(run.startedAt, now)}</time>
                    <span className={`rule-status ${chip.status}`}>
                      {!run.done && <span className="spin-inline" aria-hidden="true" />}
                      {chip.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      <div className="visual-body">
        {state.phase === "idle" && (
          <div className="visual-actions">
            <button className="visual-btn" onClick={() => void start()}>Render and review anyway</button>
            <span className="visual-note">
              {codeResult?.passed === true ? "Waiting for the run server." : "The code checks did not pass. Fix those first, or render the item and ask the model anyway (about a minute and two model calls)."}
            </span>
          </div>
        )}

      </div>
      <RunView state={state} modelKnown={modelKnown} onCancel={state.id ? () => void cancelRun(state.id!) : undefined} onRunAgain={() => void start()} />
      {opened && <RunModal run={opened} modelKnown={modelKnown} onClose={() => setOpened(null)} />}
    </section>
  );
}
