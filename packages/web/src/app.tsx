import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  validate,
  unpackZip,
  checks as checkRegistry,
  details,
  explanations,
  fixes,
  docsUrl,
  sourceLinks,
  manifest,
  registry,
  type CheckStatus,
  type Finding,
  type Group,
  type Result
} from "@dcl-regenesislabs/wearable-validator";
import { limitFor } from "./limits.js";
import { Preview } from "./preview.js";
import { MetadataValues } from "./metadata-values.js";
import { fetchItem, parseItemReference } from "./catalyst.js";
import { VisualReview } from "./visual-review.js";
import { runIdFrom } from "./run-list.js";

const GROUP_LABELS: Record<Group, string> = {
  files: "Files & metadata",
  model: "3D model",
  emote: "Animation",
  rendering: "Rendering",
  content: "Content"
};
const CODE_CHECK_COUNT = registry.filter((check) => check.group !== "rendering").length;
const GROUP_ORDER: Group[] = ["files", "model", "emote", "content"];
const GROUP_INTROS: Record<Group, string> = {
  files: "The cheapest checks run first: the package's files, sizes, metadata and integrity — everything knowable without opening the 3D model.",
  model: "The 3D model itself: geometry budgets, textures, materials, skeleton and skinning — parsed from the GLB and measured exactly.",
  emote: "The animation data: length, clips, bone targets, root motion and sound — measured from the keyframes.",
  rendering: "Real renders reviewed against the thumbnail — rendered by the local run server (npm run serve) and streamed here as they happen.",
  content: "Deterministic content screening. The AI-based IP and policy checks arrive with the renderer."
};
const CATEGORIES = Object.keys(manifest.triangles.perCategory).concat(manifest.facialCategories);
const GLYPHS: Record<string, string> = { passed: "✓", failed: "✕", warning: "!", skipped: "○", errored: "‼" };

const STATUS_LABELS: Record<CheckStatus, string> = {
  passed: "Passed", failed: "Needs fixing", warning: "Review", skipped: "Not checked", errored: "Check error"
};
const RESULT_FILTERS = [
  { key: "all", label: "All rules", statuses: ["passed", "failed", "warning", "skipped", "errored"] },
  { key: "attention", label: "Needs attention", statuses: ["failed", "warning", "errored"] },
  { key: "passed", label: "Passed", statuses: ["passed"] },
  { key: "unchecked", label: "Not checked", statuses: ["skipped"] }
];

interface Loaded {
  name: string;
  bytes?: Uint8Array;
  isBareGlb: boolean;
  /** Published-item analysis: entity files + metadata fetched from catalyst. */
  files?: Map<string, Uint8Array>;
  metadata?: unknown;
  content?: { file: string; hash: string }[];
  /** Category read from a zip's embedded manifest (limit display). */
  zipMetadata?: unknown;
  zipMetadataSource?: string;
  zipCategory?: string;
  zipHides?: string[];
  zipFiles?: Map<string, Uint8Array>;
}

interface Sample {
  key: string;
  label: string;
  name: string;
  file: string;
  kind: "wearable" | "emote";
}

export async function zipRuleContext(bytes: Uint8Array): Promise<Pick<Loaded, "zipCategory" | "zipHides" | "zipMetadata" | "zipMetadataSource" | "zipFiles">> {
  const { files: zipFiles } = await unpackZip(bytes);
  try {
    const name = zipFiles.has("wearable.json") ? "wearable.json" : "emote.json";
    const bytes = zipFiles.get(name);
    if (bytes) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { category?: string; data?: { category?: string; hides?: string[] } };
      return { zipFiles, zipCategory: parsed.data?.category ?? parsed.category, zipHides: parsed.data?.hides, zipMetadata: parsed, zipMetadataSource: name };
    }
  } catch {
    // Validation reports malformed packages; display hints remain optional.
  }
  return { zipFiles };
}

export function App() {
  const [filter, setFilter] = useState("all");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [typeOverride, setTypeOverride] = useState<"" | "wearable" | "emote">("");
  const [crash, setCrash] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const runSeq = useRef(0);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [fetching, setFetching] = useState<string | null>(null);
  // the `?run=<id>` of the URL: a visual review to open on top (read on load and on back/forward)
  const [openRunId, setOpenRunId] = useState<string | null>(() => runIdFrom(location.search));
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;

  useEffect(() => {
    fetch("samples/index.json")
      .then((r) => (r.ok ? (r.json() as Promise<Sample[]>) : []))
      .then(setSamples)
      .catch(() => setSamples([]));
  }, []);

  const run = useCallback(async (file: Loaded, cat: string, type: "" | "wearable" | "emote") => {
    const id = ++runSeq.current;
    setRunning(true);
    setFilter("all");
    setCrash(null);
    try {
      const options = { ...(cat ? { category: cat } : {}), ...(type ? { itemType: type } : {}) };
      const res = file.files
        ? await validate({ files: file.files, metadata: file.metadata, content: file.content }, options)
        : await validate(file.bytes!, options);
      if (id !== runSeq.current) return; // a newer drop superseded this run
      setResult(res);
    } catch (err) {
      if (id !== runSeq.current) return;
      setCrash(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      if (id === runSeq.current) setRunning(false);
    }
  }, []);

  const onReference = useCallback(
    async (raw: string, updateHistory = true) => {
      let candidates: string[] | null;
      try {
        candidates = parseItemReference(raw);
      } catch (err) {
        setCrash(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!candidates) {
        setCrash("That doesn't look like a shop item URL or a wearable URN (expected decentraland.org/shop/item/0x…/N or urn:decentraland:…).");
        return;
      }
      setCrash(null);
      setFetching("looking up the item…");
      try {
        const item = await fetchItem(candidates, setFetching);
        if (updateHistory) history.pushState({ urn: item.urn }, "", `?urn=${encodeURIComponent(item.urn)}`);
        const next: Loaded = { name: item.name, isBareGlb: false, files: item.files, metadata: item.metadata, content: item.content };
        setLoaded(next);
        setResult(null);
        setCategory("");
        setTypeOverride("");
        await run(next, "", "");
      } catch (err) {
        setCrash(err instanceof Error ? err.message : String(err));
      } finally {
        setFetching(null);
      }
    },
    [run]
  );

  const onSample = useCallback(
    async (sample: Sample) => {
      try {
        const res = await fetch(`samples/${sample.file}`);
        if (!res.ok) return;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const next: Loaded = { name: `${sample.name} (${sample.label} sample)`, bytes, isBareGlb: false, ...await zipRuleContext(bytes) };
        setLoaded(next);
        setResult(null);
        setCategory("");
        setTypeOverride("");
        await run(next, "", "");
      } catch (error) {
        setLoaded(null);
        setResult(null);
        setCrash(error instanceof Error ? error.message : String(error));
      }
    },
    [run]
  );

  const onFile = useCallback(
    async (file: File) => {
      try {
        if (file.size > manifest.fileSize.maxInputBytes) throw new Error(`The file exceeds the ${manifest.fileSize.maxInputBytes / 1048576} MB input limit.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const isBareGlb = bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
        if (location.search) history.pushState({}, "", location.pathname);
        setOpenRunId(null);
        const next: Loaded = { name: file.name, bytes, isBareGlb };
        if (!isBareGlb && file.name.endsWith(".zip")) Object.assign(next, await zipRuleContext(bytes));
        setLoaded(next);
        setResult(null);
        setCategory("");
        setTypeOverride("");
        await run(next, "", "");
      } catch (error) {
        setLoaded(null);
        setResult(null);
        setCrash(error instanceof Error ? error.message : String(error));
      }
    },
    [run]
  );

  const reset = useCallback(() => {
    setLoaded(null);
    setResult(null);
    setCrash(null);
  }, []);

  useEffect(() => {
    const urn = new URLSearchParams(location.search).get("urn");
    if (urn) void onReference(urn, false);
    const onPop = () => {
      const shared = new URLSearchParams(location.search).get("urn");
      setOpenRunId(runIdFrom(location.search));
      if (shared) void onReference(shared, false);
      // a dropped file has no URL of its own: backing out of a run modal must not throw its results away
      else if (!loadedRef.current?.bytes) reset();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  const findingsByCheck = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of result?.findings ?? []) {
      const list = map.get(f.check) ?? [];
      list.push(f);
      map.set(f.check, list);
    }
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

  const kind: "wearable" | "emote" = useMemo(
    () => (result?.checks.some((c) => c.group === "emote") ? "emote" : "wearable"),
    [result]
  );

  return (
    <div
      className="shell"
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void onFile(file);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => setDragging(true)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
    >
      <header className="top">
        <div className="wordmark">
          <span className="eui-overline">decentraland</span>
          <span className="title">Wearable Validator</span>
        </div>
        <div className="top-meta">
          rules <b>v{manifest.version}</b> · <b>{CODE_CHECK_COUNT}</b> checks · runs in your browser
        </div>
      </header>

      {!loaded && !fetching && (
        <>
          <Dropzone dragging={dragging} onFile={onFile} samples={samples} onSample={onSample} onReference={onReference} />
          <div className="landing-runs"><VisualReview name="" codeResult={null} openRunId={openRunId} /></div>
        </>
      )}
      {fetching && (
        <div style={{ textAlign: "center" }}>
          <div className="spin" role="status" aria-label="fetching" />
          <p className="preview-note" style={{ padding: 0 }}>{fetching}</p>
        </div>
      )}
      {loaded && running && !result && <div className="spin" role="status" aria-label="validating" />}
      {crash && (
        <div className="card crash" role="alert">
          <div className="card-head"><span className="eui-overline">error</span></div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}>{crash}</p>
            <button
              className="reset-btn"
              onClick={() => {
                if (location.search) history.pushState({}, "", location.pathname);
                reset();
              }}
            >
              Validate another file
            </button>
          </div>
        </div>
      )}

      {loaded && result && (
        <div className="results">
          <aside className="rail">
            <div className="card">
              <div className="card-head"><span className="eui-overline">item</span></div>
              <div className="card-body">
                <p className="item-name">{loaded.name}</p>
                <dl className="item-facts">
                  <dt>size</dt>
                  <dd>
                    {(
                      ((loaded.bytes?.length ?? 0) + [...(loaded.files?.values() ?? [])].reduce((n, b) => n + b.length, 0)) / 1048576
                    ).toFixed(2)}{" "}
                    MB
                  </dd>
                  <dt>input</dt>
                  <dd>{loaded.files ? "published example" : loaded.isBareGlb ? "GLB upload" : loaded.name.endsWith(".zip") ? "zip package" : "file"}</dd>
                  <dt>type</dt>
                  <dd>{kind}</dd>
                </dl>
                {loaded.isBareGlb && (
                  <select
                    className="category"
                    value={typeOverride}
                    onChange={(e) => {
                      const t = e.target.value as "" | "wearable" | "emote";
                      setTypeOverride(t);
                      void run(loaded, category, t);
                    }}
                    aria-label="item type"
                  >
                    <option value="">type: auto ({kind} — inferred from animation clips)</option>
                    <option value="wearable">type: wearable</option>
                    <option value="emote">type: emote</option>
                  </select>
                )}
                {loaded.isBareGlb && (
                  <select
                    className="category"
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      void run(loaded, e.target.value, typeOverride);
                    }}
                    aria-label="category hint"
                  >
                    <option value="">category: unknown (pick to check limits)</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        category: {c}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            <Preview key={loaded.name + (loaded.bytes?.length ?? loaded.files?.size ?? 0)} file={loaded} kind={kind} category={category || undefined} />
            <button
              className="reset-btn"
              onClick={() => {
                if (location.search) history.pushState({}, "", location.pathname);
                reset();
              }}
            >
              Validate another file
            </button>
          </aside>

          <main>
            <Verdict result={result} bare={loaded.isBareGlb} />
            {loaded.isBareGlb && <p className="glb-scope">Results cover the uploaded GLB. Choose its type and category to check the right limits. Package metadata and publishing checks are not part of this analysis.</p>}
            <div className="rules-toolbar">
              <div>
                <h1>Rule results</h1>
                <p>Compare your values with the requirements. Open a rule for findings and fix steps.</p>
              </div>
              <div className="result-filters" role="group" aria-label="Filter rule results">
                {RESULT_FILTERS.map((option) => (
                  <button key={option.key} aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>
                    {option.label} <span>{result.checks.filter((row) => option.statuses.includes(row.status)).length}</span>
                  </button>
                ))}
              </div>
            </div>
            {!result.checks.some((row) => RESULT_FILTERS.find((option) => option.key === filter)!.statuses.includes(row.status)) && (
              <p className="empty-results" role="status">No rules in this view. Choose All rules to see every result.</p>
            )}
            {GROUP_ORDER.map((group, gi) => {
              const groupRows = result.checks.filter((c) => c.group === group);
              const rows = groupRows.filter((row) => RESULT_FILTERS.find((option) => option.key === filter)!.statuses.includes(row.status));
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
                  <div className="rule-columns" aria-hidden="true">
                    <span>Rule</span><span>Your value</span><span>Requirement</span><span>Status</span><span />
                  </div>
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
                            <span className={`rule-status ${row.status}`}>
                              <span aria-hidden="true">{GLYPHS[row.status]}</span> {STATUS_LABELS[row.status]}
                            </span>
                            <span className="rule-chevron" aria-hidden="true">›</span>
                          </summary>
                          <div className="check-body">
                            {row.status === "skipped" && <p className="skip-note">skipped — {row.skipReason}</p>}
                            {row.status === "errored" && <p className="skip-note">check crashed — {row.skipReason}</p>}
                            {findings.map((f, fi) => (
                              <div className={`finding ${f.severity}`} key={fi}>
                                <p className="msg">{f.message}</p>
                                {(f.where || f.measured !== undefined) && (
                                  <div className="meta">
                                    {f.where && <span>{f.where}</span>}
                                    {f.measured !== undefined && (
                                      <span>
                                        measured <span className="ml">{String(f.measured)}</span>
                                        {f.limit !== undefined && (
                                          <>
                                            {" "}/ limit <span className="ml">{String(f.limit)}</span>
                                          </>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
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
            {!loaded.isBareGlb && !loaded.files && <VisualReview bytes={loaded.bytes} name={loaded.name} codeResult={result} openRunId={openRunId} />}
            <footer className="foot">
              Checks that don't apply to this item (wrong item type, or metadata a bare .glb can't carry) aren't shown — that's
              why fewer than {CODE_CHECK_COUNT} appear. Code checks never leave this page. The visual review, when a run server is
              running, uploads the zip to it and streams the screenshots back.
            </footer>
          </main>
        </div>
      )}
    </div>
  );
}

function CheckAbout({ check, rule, collapsed }: { check: string; rule?: string; collapsed: boolean }) {
  const body = (
    <>
      <p className="explain">{explanations[check]}</p>
      {details[check] && <p className="how">{details[check]}</p>}
      <div className="about-meta">
        <span>
          {check} · {rule}
        </span>
        <a href={docsUrl(check)} target="_blank" rel="noreferrer">
          docs ↗
        </a>
        <a href={sourceLinks[check]} target="_blank" rel="noreferrer">
          source ↗
        </a>
      </div>
    </>
  );
  if (!collapsed) return <div className="about">{body}</div>;
  return (
    <details className="about">
      <summary>About this check</summary>
      {body}
    </details>
  );
}

function Dropzone({
  dragging,
  onFile,
  samples,
  onSample,
  onReference
}: {
  dragging: boolean;
  onFile: (f: File) => void;
  samples: Sample[];
  onSample: (s: Sample) => void;
  onReference: (raw: string) => void;
}) {
  const [reference, setReference] = useState("");
  return (
    <>
    <label className={`dropzone${dragging ? " drag" : ""}`}>
      <input
        type="file"
        accept=".zip,.glb,.png"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />
      <h1>Check your wearable or emote GLB</h1>
      <p>Drop your export to inspect geometry, textures, rigging, and animation.</p>
      <div className="formats">
        <span className="chip">.glb — your model</span>
        <span className="chip">.zip — Builder export also supported</span>
      </div>
      <p className="privacy">code checks run 100% in your browser — only the visual review uploads the zip to the run server</p>
    </label>
    <details className="published-example">
      <summary>Explore a published example</summary>
    <form
      className="reference"
      onSubmit={(e) => {
        e.preventDefault();
        if (reference.trim()) onReference(reference);
      }}
    >
      <input
        className="reference-input"
        placeholder="Paste a shop item URL or URN"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        aria-label="marketplace URL or URN"
      />
      <button className="reference-btn" type="submit">Load example</button>
    </form>
    </details>
    {samples.length > 0 && (
      <div className="samples">
        <span className="samples-label">See how it works with an example</span>
        <div className="samples-row">
          {samples.map((s) => (
            <button key={s.key} className="sample-chip" title={s.name} onClick={() => onSample(s)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    )}
    </>
  );
}

function Verdict({ result, bare }: { result: Result; bare: boolean }) {
  const { errors, warnings, checked } = result.summary;
  return (
    <div className="verdict">
      <div className="verdict-word">
        <span className="eui-overline">{bare ? "GLB analysis" : "verdict"}</span>
        {result.passed === true && <span className="stamp pass">Passed</span>}
        {result.passed === false && <span className="stamp fail">Failed</span>}
        {result.passed === null && <span className={`stamp ${bare ? "analysis" : "none"}`}>{bare ? "Model checks" : "Incomplete"}</span>}
      </div>
      <div className="verdict-facts">
        <div>
          <span className={`n${errors ? " err" : ""}`}>{errors}</span> errors ·{" "}
          <span className={`n${warnings ? " wrn" : ""}`}>{warnings}</span> warnings
        </div>
        <div>
          <span className="n">{checked}</span> of {CODE_CHECK_COUNT} checks apply
          {result.summary.skipped > 0 && <> · {result.summary.skipped} skipped</>}
        </div>
      </div>
    </div>
  );
}
