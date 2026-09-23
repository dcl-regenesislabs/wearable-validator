import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { validate, checks as checkRegistry, fixes, manifest, registry, type Finding, type Group, type ProgressEvent, type Result } from "@dcl-regenesislabs/wearable-validator";
import { cancelRun, followRun, startRun } from "./api.js";
import { fetchItem, parseItemReference } from "./catalyst.js";
import { formatBytes, inputKind, isGlb, isPng, itemBytes, zipRuleContext, type Loaded, type Sample } from "./item.js";
import { limitFor } from "./limits.js";
import { MetadataValues } from "./metadata-values.js";
import { Preview } from "./preview.js";
import { CODE_GROUPS, EMPTY_VISUAL, GROUP_LABELS, codeSteps, combinedVerdict, isRunning, reduceVisual, visualRows, type Step, type VisualEvent, type VisualState } from "./progress.js";
import { CheckAbout, FindingCard, Notice, RESULT_FILTERS, RuleColumns, StatusChip, filterStatuses } from "./rules.js";
import { RunView } from "./run-view.js";
import { isModifiedClick, type Route } from "./run-list.js";
import type { Server } from "./server.js";
import { Stepper } from "./stepper.js";

/**
 * The Validate tab: the landing drop zone, the progress view while a file is read and its checks run, then the
 * results — rail (item, preview) and main (verdict, rule groups, the visual review of this item). History lives
 * on its own tab; nothing about other runs is shown here.
 */

const GROUP_INTROS: Record<Group, string> = {
  files: "The cheapest checks run first: the package's files, sizes, metadata and integrity — everything knowable without opening the 3D model.",
  model: "The 3D model itself: geometry budgets, textures, materials, skeleton and skinning — parsed from the GLB and measured exactly.",
  emote: "The animation data: length, clips, bone targets, root motion and sound — measured from the keyframes.",
  rendering: "Real renders reviewed against the thumbnail — rendered by the run server and streamed here as they happen.",
  content: "Deterministic content screening."
};
const CATEGORIES = Object.keys(manifest.triangles.perCategory).concat(manifest.facialCategories);
const CODE_CHECK_COUNT = registry.filter((check) => check.group !== "rendering").length;

interface Reading {
  label: string;
  detail?: string;
}

export interface ValidateViewProps {
  server: Server;
  /** `?urn=` of the URL: the catalyst item to show; null clears a shown one on back/forward. */
  urn: string | null;
  /** A file dropped anywhere on the page. */
  incoming: { file: File; seq: number } | null;
  navigate: (patch: Partial<Route>) => void;
}

export function ValidateView({ server, urn, incoming, navigate }: ValidateViewProps) {
  const [filter, setFilter] = useState("all");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [category, setCategory] = useState("");
  const [typeOverride, setTypeOverride] = useState<"" | "wearable" | "emote">("");
  const [notice, setNotice] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const runSeq = useRef(0);
  // every load path (drop, sample, URN) bumps it; a slower earlier load must not replace the newer item
  const loadSeq = useRef(0);
  /** The loadSeq of the last catalyst fetch, so backing out of `?urn=` discards it and nothing else. */
  const urnLoad = useRef(0);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  const resultRef = useRef<Result | null>(null);
  resultRef.current = result;

  useEffect(() => {
    fetch("samples/index.json")
      .then((r) => (r.ok ? (r.json() as Promise<Sample[]>) : []))
      .then(setSamples)
      .catch(() => setSamples([]));
  }, []);

  const run = useCallback(async (file: Loaded, cat: string, type: "" | "wearable" | "emote") => {
    const id = ++runSeq.current;
    setRunning(true);
    setEvents([]);
    setFilter("all");
    setNotice(null);
    try {
      const options = {
        ...(cat ? { category: cat } : {}),
        ...(type ? { itemType: type } : {}),
        // the library yields to the event loop after each check when it reports progress, so every step paints
        onProgress: (event: ProgressEvent) => {
          if (id === runSeq.current) setEvents((list) => [...list, event]);
        }
      };
      const res = file.files
        ? await validate({ files: file.files, metadata: file.metadata, content: file.content }, options)
        : await validate(file.bytes!, options);
      if (id !== runSeq.current) return; // a newer drop superseded this run
      setResult(res);
    } catch (err) {
      if (id !== runSeq.current) return;
      setNotice(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      if (id === runSeq.current) setRunning(false);
    }
  }, []);

  const show = useCallback(
    async (next: Loaded) => {
      setLoaded(next);
      setResult(null);
      setCategory("");
      setTypeOverride("");
      setReading(null);
      await run(next, "", "");
    },
    [run]
  );

  const fail = useCallback((error: unknown) => {
    setLoaded(null);
    setResult(null);
    setReading(null);
    setNotice(error instanceof Error ? error.message : String(error));
  }, []);

  const onReference = useCallback(
    async (raw: string, updateHistory = true) => {
      let candidates: string[] | null;
      try {
        candidates = parseItemReference(raw);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!candidates) {
        setNotice("That doesn't look like a shop item URL or a wearable URN (expected decentraland.org/shop/item/0x…/N or urn:decentraland:…).");
        return;
      }
      const id = ++loadSeq.current;
      urnLoad.current = id;
      setNotice(null);
      setLoaded(null);
      setResult(null);
      setReading({ label: "Fetching the published item", detail: "Looking up the item" });
      try {
        const item = await fetchItem(candidates, (detail) => {
          if (id === loadSeq.current) setReading({ label: "Fetching the published item", detail });
        });
        if (id !== loadSeq.current) return;
        if (updateHistory) navigate({ tab: "validate", run: null, urn: item.urn });
        await show({ name: item.name, isBareGlb: false, urn: item.urn, files: item.files, metadata: item.metadata, content: item.content });
      } catch (err) {
        if (id === loadSeq.current) fail(err);
      }
    },
    [fail, navigate, show]
  );

  const onSample = useCallback(
    async (sample: Sample) => {
      const id = ++loadSeq.current;
      setNotice(null);
      setLoaded(null);
      setResult(null);
      navigate({ tab: "validate", run: null, urn: null });
      setReading({ label: `Downloading ${sample.name}`, detail: `${sample.label} sample` });
      try {
        const res = await fetch(`samples/${sample.file}`);
        if (!res.ok) throw new Error(`The sample could not be downloaded (${res.status}).`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (id !== loadSeq.current) return;
        setReading({ label: `Reading ${sample.name}`, detail: formatBytes(bytes.length) });
        const context = await zipRuleContext(bytes);
        if (id !== loadSeq.current) return;
        await show({ name: `${sample.name} (${sample.label} sample)`, bytes, isBareGlb: false, ...context });
      } catch (error) {
        if (id === loadSeq.current) fail(error);
      }
    },
    [fail, navigate, show]
  );

  const onFile = useCallback(
    async (file: File) => {
      const id = ++loadSeq.current;
      setNotice(null);
      setLoaded(null);
      setResult(null);
      navigate({ tab: "validate", run: null, urn: null });
      setReading({ label: `Reading ${file.name}`, detail: formatBytes(file.size) });
      try {
        if (file.size > manifest.fileSize.maxInputBytes) throw new Error(`The file exceeds the ${manifest.fileSize.maxInputBytes / 1048576} MB input limit.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (id !== loadSeq.current) return;
        if (isPng(bytes) || /\.png$/i.test(file.name)) {
          throw new Error("A PNG on its own cannot be checked: it needs the item's category and model. Drop the Builder zip (model, thumbnail and metadata together) or the .glb.");
        }
        const isBareGlb = isGlb(bytes);
        const next: Loaded = { name: file.name, bytes, isBareGlb };
        if (!isBareGlb && file.name.endsWith(".zip")) {
          const context = await zipRuleContext(bytes);
          if (id !== loadSeq.current) return;
          Object.assign(next, context);
        }
        await show(next);
      } catch (error) {
        if (id === loadSeq.current) fail(error);
      }
    },
    [fail, navigate, show]
  );

  const reset = useCallback(() => {
    loadSeq.current++;
    setLoaded(null);
    setResult(null);
    setNotice(null);
    setReading(null);
    navigate({ urn: null });
  }, [navigate]);

  // the URL's catalyst item: load it on arrival and on back/forward; backing out of it clears the page
  useEffect(() => {
    if (!urn) {
      if (urnLoad.current === loadSeq.current) loadSeq.current++;
      if (loadedRef.current?.urn) {
        setLoaded(null);
        setResult(null);
      }
      return;
    }
    if (loadedRef.current?.urn === urn) return;
    void onReference(urn, false);
  }, [urn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (incoming) void onFile(incoming.file);
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── the visual review of this item ──────────────────────────────────────────
  const [visual, setVisual] = useState<VisualState>(EMPTY_VISUAL);
  const stopRef = useRef<(() => void) | null>(null);
  // stopRef is null while an upload is in flight, so a newer item supersedes by sequence: the stale run is cancelled, not followed
  const visualSeq = useRef(0);
  const emit = useCallback((event: VisualEvent) => setVisual((state) => reduceVisual(state, event)), []);
  const { refreshHealth, refreshRuns } = server;

  const startVisual = useCallback(async () => {
    const item = loadedRef.current;
    if (!item?.bytes || item.isBareGlb || item.files) return;
    const seq = ++visualSeq.current;
    stopRef.current?.();
    setVisual(reduceVisual(EMPTY_VISUAL, { type: "upload-started" }));
    try {
      // the server may have been restarted with other flags since the page loaded
      const health = await refreshHealth();
      if (seq !== visualSeq.current) return;
      if (!health) throw new Error("The run server is not reachable. Start it with npm run serve at the repo root.");
      const { id } = await startRun(item.bytes, item.name, { model: true, standalone: resultRef.current?.passed !== true });
      if (seq !== visualSeq.current) {
        void cancelRun(id);
        return;
      }
      emit({ type: "upload-finished", id });
      stopRef.current = followRun(id, emit);
      refreshRuns();
    } catch (error) {
      if (seq !== visualSeq.current) return;
      emit({ type: "error", data: { message: error instanceof Error ? error.message : "Could not start the run." } });
    }
  }, [emit, refreshHealth, refreshRuns]);

  const cancelVisual = useCallback(() => {
    if (!visual.id) return;
    emit({ type: "cancel-requested" });
    void cancelRun(visual.id);
  }, [emit, visual.id]);

  const reviewable = Boolean(loaded?.bytes && !loaded.isBareGlb && !loaded.files);
  // clean code checks: render and ask right away. Code errors: the creator has things to fix first, so nothing
  // runs (no minute of screenshots nobody will use) until they press the button.
  useEffect(() => {
    visualSeq.current++;
    stopRef.current?.();
    stopRef.current = null;
    setVisual(EMPTY_VISUAL);
    if (server.known && reviewable && result?.passed === true) void startVisual();
  }, [server.known, reviewable, loaded, result, startVisual]);
  useEffect(() => () => stopRef.current?.(), []);

  // History mirrors the server: re-read it whenever this item's run changes state
  useEffect(() => {
    if (visual.phase !== "idle") refreshRuns();
  }, [visual.phase, refreshRuns]);

  // ── derived ─────────────────────────────────────────────────────────────────
  const findingsByCheck = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of result?.findings ?? []) map.set(f.check, [...(map.get(f.check) ?? []), f]);
    return map;
  }, [result]);
  const resolvedCategory = useMemo(() => {
    const meta = loaded?.metadata as { data?: { category?: string } } | undefined;
    return meta?.data?.category ?? loaded?.zipCategory ?? (category || undefined);
  }, [loaded, category]);
  const hides = useMemo(() => {
    const meta = loaded?.metadata as { data?: { hides?: string[] } } | undefined;
    return meta?.data?.hides ?? loaded?.zipHides;
  }, [loaded]);
  const kind: "wearable" | "emote" = useMemo(() => (result?.checks.some((c) => c.group === "emote") ? "emote" : "wearable"), [result]);

  const busy = reading !== null || (loaded !== null && running && result === null);
  const steps: Step[] = useMemo(() => {
    const first: Step = reading
      ? { key: "read", label: reading.label, state: "active", detail: reading.detail }
      : { key: "read", label: `Reading ${loaded?.name ?? ""}`, state: "done", detail: loaded ? formatBytes(itemBytes(loaded)) : undefined };
    return [first, ...codeSteps(events, !running && result !== null)];
  }, [reading, loaded, events, running, result]);

  const statuses = filterStatuses(filter);
  const visualRowsNow = visualRows(visual);
  const modelKnown = server.capabilities?.reviewer === "pi";

  const progressCard = (
    <section className="eui-panel progress-card">
      <div className="eui-panel-head">
        <div className="eui-head-text">
          <span className="eui-overline">Validating</span>
          <span className="eui-title">{loaded?.name ?? reading?.label ?? ""}</span>
        </div>
        {loaded && <span className="head-meta">{formatBytes(itemBytes(loaded))}</span>}
      </div>
      <div className="eui-panel-body visual-body">
        <Stepper steps={steps} label="Validation progress" />
      </div>
    </section>
  );

  const onLanding = !loaded && !busy;
  const noticeBlock = notice && (
    <div className="notice-stage" role="alert">
      <Notice tone="attention">
        <strong>Could not validate.</strong> {notice}
      </Notice>
      {!onLanding && <button type="button" className="eui-ds-btn secondary sm" onClick={reset}>Validate another file</button>}
    </div>
  );

  return (
    <div className="validate">
      {onLanding && (
        <Landing
          onFile={onFile}
          samples={samples}
          onSample={onSample}
          onReference={onReference}
          earlierRuns={server.runs.length}
          onHistory={() => navigate({ tab: "history", run: null })}
          notice={noticeBlock}
        />
      )}
      {busy && !result && <div className="progress-stage">{progressCard}</div>}
      {!onLanding && noticeBlock}

      {loaded && result && (
        <div className={`results${running ? " dim" : ""}`} aria-busy={running || undefined}>
          <aside className="rail">
            <div className="eui-panel">
              <div className="eui-panel-head">
                <div className="eui-head-text">
                  <span className="eui-overline">Item</span>
                  <span className="eui-title">{loaded.name}</span>
                </div>
              </div>
              <div className="eui-panel-body rail-body">
                <dl className="item-facts">
                  <dt>Size</dt>
                  <dd>{formatBytes(itemBytes(loaded))}</dd>
                  <dt>Input</dt>
                  <dd>{inputKind(loaded)}</dd>
                  <dt>Type</dt>
                  <dd>{kind}</dd>
                  {resolvedCategory && (
                    <>
                      <dt>Category</dt>
                      <dd>{resolvedCategory}</dd>
                    </>
                  )}
                </dl>
                {loaded.isBareGlb && (
                  <div className="rail-fields">
                    <label className="eui-home-flabel" htmlFor="item-type">Item type</label>
                    <select
                      id="item-type"
                      className="eui-select"
                      value={typeOverride}
                      onChange={(e) => {
                        const t = e.target.value as "" | "wearable" | "emote";
                        setTypeOverride(t);
                        void run(loaded, category, t);
                      }}
                    >
                      <option value="">Auto ({kind}, from the animation clips)</option>
                      <option value="wearable">Wearable</option>
                      <option value="emote">Emote</option>
                    </select>
                    <label className="eui-home-flabel" htmlFor="item-category">Category</label>
                    <select
                      id="item-category"
                      className="eui-select"
                      value={category}
                      onChange={(e) => {
                        setCategory(e.target.value);
                        void run(loaded, e.target.value, typeOverride);
                      }}
                    >
                      <option value="">Unknown — pick one to check its limits</option>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
            <Preview key={loaded.name + (loaded.bytes?.length ?? loaded.files?.size ?? 0)} file={loaded} kind={kind} category={category || undefined} />
            <button type="button" className="eui-ds-btn secondary md rail-cta" onClick={reset}>Validate another file</button>
          </aside>

          <main>
            {running && progressCard}
            <Verdict result={result} visual={visualRowsNow} visualPhase={visual.phase} bare={loaded.isBareGlb} reviewable={reviewable && server.known} />
            {loaded.isBareGlb && <p className="glb-scope">Results cover the uploaded GLB. Choose its type and category to check the right limits. Package metadata and publishing checks are not part of this analysis.</p>}
            <div className="rules-toolbar">
              <div>
                <h1>Rule results</h1>
                <p>Compare your values with the requirements. Open a rule for findings and fix steps.</p>
              </div>
              <div className="eui-seg" role="group" aria-label="Filter rule results">
                {RESULT_FILTERS.map((option) => {
                  const total = result.checks.filter((row) => option.statuses.includes(row.status)).length + visualRowsNow.filter((row) => option.statuses.includes(row.status)).length;
                  return (
                    <button key={option.key} type="button" className={`eui-seg-btn${filter === option.key ? " active" : ""}`} aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>
                      {option.label} <span className="ct">{total}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {!result.checks.some((row) => statuses.includes(row.status)) && !visualRowsNow.some((row) => statuses.includes(row.status)) && (
              <p className="empty-results" role="status">No rules in this view. Choose All rules to see every result.</p>
            )}
            {CODE_GROUPS.map((group, gi) => {
              const groupRows = result.checks.filter((c) => c.group === group);
              const rows = groupRows.filter((row) => statuses.includes(row.status));
              if (rows.length === 0) return null;
              const passed = groupRows.filter((r) => r.status === "passed").length;
              const notApplicable = registry.filter((c) => c.group === group).length - groupRows.length;
              return (
                <section className="group" key={group} style={{ animationDelay: `${gi * 0.05}s` }}>
                  <div className="group-head" title={GROUP_INTROS[group]}>
                    <h2>{GROUP_LABELS[group]}</h2>
                    <span className="tally">
                      {passed}/{groupRows.length} passed{notApplicable > 0 && <> · {notApplicable} n/a</>}
                    </span>
                  </div>
                  <RuleColumns />
                  <div className="group-list">
                    {rows.map((row) => {
                      const findings = findingsByCheck.get(row.check) ?? [];
                      const def = checkRegistry[row.check];
                      const requirement = limitFor(row.check, resolvedCategory, hides);
                      const unavailable = row.status === "skipped" || row.status === "errored";
                      return (
                        <details className={`check ${row.status}`} key={row.check}>
                          <summary>
                            <span className="check-title">{def?.title ?? row.check}</span>
                            <span className={`rule-value${row.measured === undefined ? " unavailable" : ""}`}>
                              <span className="mobile-label">Your value</span>
                              {row.measured ?? (unavailable ? "Not measured" : "No measurement reported")}
                            </span>
                            <span className="rule-requirement">
                              <span className="mobile-label">Requirement</span>
                              {requirement ?? def?.describe ?? "—"}
                            </span>
                            <StatusChip status={row.status} />
                            <span className="rule-chevron" aria-hidden="true">›</span>
                          </summary>
                          <div className="check-body">
                            {row.status === "skipped" && <p className="skip-note">skipped — {row.skipReason}</p>}
                            {row.status === "errored" && <p className="skip-note">check crashed — {row.skipReason}</p>}
                            {findings.map((f, fi) => <FindingCard finding={f} key={fi} />)}
                            {(row.status === "failed" || row.status === "warning") && fixes[row.check] && (
                              <p className="fix-hint">
                                <span className="fix-label">How to fix</span>
                                {fixes[row.check]}
                              </p>
                            )}
                            {row.check === "metadata" && (
                              <MetadataValues
                                value={loaded.metadata ?? loaded.zipMetadata}
                                source={loaded.metadata !== undefined ? "Published entity" : loaded.zipMetadataSource ?? "Package metadata"}
                              />
                            )}
                            <CheckAbout check={row.check} rule={def?.rule} collapsed={findings.length > 0 || row.check === "metadata"} />
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {reviewable && server.known && (
              <RunView
                state={visual}
                aiChecks={server.aiChecks}
                modelKnown={modelKnown}
                filter={filter}
                onCancel={visual.id && isRunning(visual.phase) ? cancelVisual : undefined}
                onRunAgain={() => void startVisual()}
                gate={<GateRow passed={result.passed === true} onStart={() => void startVisual()} />}
              />
            )}
            <footer className="foot">
              Checks that don't apply to this item (wrong item type, or metadata a bare .glb can't carry) aren't shown — that's
              why fewer than {CODE_CHECK_COUNT} appear. Code checks never leave this page. The visual review, when a run server is
              connected, uploads the zip to it and streams the screenshots back.
            </footer>
          </main>
        </div>
      )}
    </div>
  );
}

/** The gate before a render: automatic after clean code checks, a deliberate button after failed ones. */
function GateRow({ passed, onStart }: { passed: boolean; onStart: () => void }) {
  return (
    <div className="gate-row">
      <button type="button" className="eui-ds-btn primary md" onClick={onStart}>{passed ? "Render and review" : "Render and review anyway"}</button>
      <p className="gate-note">
        {passed
          ? "Renders the item on the run server and asks the model about the photos."
          : "The code checks did not pass. Fix those first, or render the item and ask the model anyway (about a minute)."}
      </p>
    </div>
  );
}

interface LandingProps {
  onFile: (file: File) => void;
  samples: Sample[];
  onSample: (sample: Sample) => void;
  onReference: (raw: string) => void;
  earlierRuns: number;
  onHistory: () => void;
  /** The last load's error, shown right under the drop zone the creator just used. */
  notice?: ReactNode;
}

function Landing({ onFile, samples, onSample, onReference, earlierRuns, onHistory, notice }: LandingProps) {
  const [reference, setReference] = useState("");
  return (
    <div className="landing">
      <label className="eui-asset eui-asset-upload hero-drop">
        <input
          type="file"
          accept=".zip,.glb"
          className="eui-sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
            e.target.value = "";
          }}
        />
        <div className="glyph" aria-hidden="true">+</div>
        <span className="name">Drop your wearable or emote here</span>
        <span className="pack">.glb model · .zip Builder export · or click to choose a file</span>
      </label>
      {notice}
      <p className="landing-note">Code checks run in your browser and never leave this page. Only the visual review uploads the zip to the run server.</p>
      {samples.length > 0 && (
        <div className="samples">
          <span className="eui-home-flabel">Try a sample</span>
          <div className="samples-row">
            {samples.map((s) => (
              <button key={s.key} type="button" className="eui-ds-chip sample-chip" title={s.name} onClick={() => onSample(s)}>
                <span className="txt">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        className="reference"
        onSubmit={(e) => {
          e.preventDefault();
          if (reference.trim()) onReference(reference);
        }}
      >
        <label className="eui-home-flabel" htmlFor="reference">Or check a published item</label>
        <div className="reference-row">
          <input id="reference" className="eui-input md" placeholder="Paste a shop item URL or URN" value={reference} onChange={(e) => setReference(e.target.value)} />
          <button type="submit" className="eui-ds-btn secondary md">Load item</button>
        </div>
      </form>
      {earlierRuns > 0 && (
        <p className="landing-history">
          {earlierRuns} earlier {earlierRuns === 1 ? "run" : "runs"} in{" "}
          <a
            href="/?tab=history"
            onClick={(e) => {
              if (isModifiedClick(e)) return;
              e.preventDefault();
              onHistory();
            }}
          >
            History
          </a>
        </p>
      )}
    </div>
  );
}

function Verdict({ result, visual, visualPhase, bare, reviewable }: { result: Result; visual: ReturnType<typeof visualRows>; visualPhase: VisualState["phase"]; bare: boolean; reviewable: boolean }) {
  const { errors, warnings, checked } = result.summary;
  const verdict = combinedVerdict(result, visual);
  const visualErrors = visual.flatMap((row) => row.findings).filter((f) => f.severity === "error").length;
  const visualWarnings = visual.flatMap((row) => row.findings).filter((f) => f.severity === "warning").length;
  let stamp: ReactNode;
  if (bare) stamp = <span className="stamp analysis">Model checks</span>;
  else if (verdict === "passed") stamp = <span className="stamp pass">Passed</span>;
  else if (verdict === "failed") stamp = <span className="stamp fail">Failed</span>;
  else stamp = <span className="stamp none">Incomplete</span>;
  const visualNote = !reviewable || bare ? null : visualPhase === "idle" ? "visual review not started" : isRunning(visualPhase) ? "visual review in progress" : visualPhase === "done" ? `${visual.length} visual ${visual.length === 1 ? "check" : "checks"}` : `visual review ${visualPhase}`;
  return (
    <div className="verdict">
      <div className="verdict-word">
        <span className="eui-overline">{bare ? "GLB analysis" : "Verdict"}</span>
        {stamp}
      </div>
      <div className="verdict-facts">
        <div>
          <span className={`n${errors + visualErrors ? " err" : ""}`}>{errors + visualErrors}</span> errors ·{" "}
          <span className={`n${warnings + visualWarnings ? " wrn" : ""}`}>{warnings + visualWarnings}</span> warnings
        </div>
        <div>
          <span className="n">{checked}</span> of {CODE_CHECK_COUNT} code checks apply
          {result.summary.skipped > 0 && <> · {result.summary.skipped} skipped</>}
          {visualNote && <> · {visualNote}</>}
        </div>
      </div>
    </div>
  );
}
