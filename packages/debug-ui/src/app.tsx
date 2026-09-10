import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  validate,
  checks as checkRegistry,
  details,
  explanations,
  fixes,
  limitFor,
  sourceLinks,
  manifest,
  registry,
  type Finding,
  type Group,
  type Result
} from "@dcl-regenesislabs/wearable-validator";
import JSZip from "jszip";
import { Preview } from "./preview.js";
import { fetchItem, parseItemReference } from "./catalyst.js";

const GROUP_LABELS: Record<Group, string> = {
  files: "Files & metadata",
  model: "3D model",
  emote: "Animation",
  rendering: "Rendering",
  content: "Content"
};
const GROUP_ORDER: Group[] = ["files", "model", "emote", "content"];
const GROUP_INTROS: Record<Group, string> = {
  files: "The cheapest checks run first: the package's files, sizes, metadata and integrity — everything knowable without opening the 3D model.",
  model: "The 3D model itself: geometry budgets, textures, materials, skeleton and skinning — parsed from the GLB and measured exactly.",
  emote: "The animation data: length, clips, bone targets, root motion and sound — measured from the keyframes.",
  rendering: "Real renders inspected by pixel tests — arrives with the headless renderer.",
  content: "Deterministic content screening. The AI-based IP and policy checks arrive with the renderer."
};
const CATEGORIES = Object.keys(manifest.triangles.perCategory).concat(manifest.facialCategories);
const GLYPHS: Record<string, string> = { passed: "✓", failed: "✕", warning: "!", skipped: "○", errored: "‼" };

interface Loaded {
  name: string;
  bytes?: Uint8Array;
  isBareGlb: boolean;
  /** Published-item analysis: entity files + metadata fetched from catalyst. */
  files?: Map<string, Uint8Array>;
  metadata?: unknown;
  content?: { file: string; hash: string }[];
  /** Category read from a zip's embedded manifest (limit display). */
  zipCategory?: string;
  zipHides?: string[];
}

interface Sample {
  key: string;
  label: string;
  name: string;
  file: string;
  kind: "wearable" | "emote";
}

export function App() {
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

  useEffect(() => {
    fetch("samples/index.json")
      .then((r) => (r.ok ? (r.json() as Promise<Sample[]>) : []))
      .then(setSamples)
      .catch(() => setSamples([]));
  }, []);

  const run = useCallback(async (file: Loaded, cat: string, type: "" | "wearable" | "emote") => {
    const id = ++runSeq.current;
    setRunning(true);
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
      const res = await fetch(`samples/${sample.file}`);
      if (!res.ok) return;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const next: Loaded = { name: `${sample.name} (${sample.label} sample)`, bytes, isBareGlb: false };
      setLoaded(next);
      setResult(null);
      setCategory("");
      setTypeOverride("");
      await run(next, "", "");
    },
    [run]
  );

  const onFile = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isBareGlb = bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
      if (location.search) history.pushState({}, "", location.pathname);
      const next: Loaded = { name: file.name, bytes, isBareGlb };
      if (!isBareGlb && file.name.endsWith(".zip")) {
        try {
          const zip = await JSZip.loadAsync(bytes);
          const manifestEntry = zip.file("wearable.json") ?? zip.file("emote.json");
          if (manifestEntry) {
            const parsed = JSON.parse(await manifestEntry.async("string")) as { category?: string; data?: { category?: string; hides?: string[] } };
            next.zipCategory = parsed.data?.category ?? parsed.category;
            next.zipHides = parsed.data?.hides;
          }
        } catch {
          // metadata check reports unparseable manifests; limit chips just stay generic
        }
      }
      setLoaded(next);
      setResult(null);
      setCategory("");
      setTypeOverride("");
      await run(next, "", "");
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
      if (shared) void onReference(shared, false);
      else reset();
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
          rules <b>v{manifest.version}</b> · <b>{registry.length}</b> checks · runs in your browser
        </div>
      </header>

      {!loaded && !fetching && <Dropzone dragging={dragging} onFile={onFile} samples={samples} onSample={onSample} onReference={onReference} />}
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
                  <dd>{loaded.files ? "published item (catalyst)" : loaded.isBareGlb ? "bare .glb — advisory run" : loaded.name.endsWith(".zip") ? "zip package" : "file"}</dd>
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
            {GROUP_ORDER.map((group, gi) => {
              const rows = result.checks.filter((c) => c.group === group);
              if (rows.length === 0) return null;
              const passed = rows.filter((r) => r.status === "passed").length;
              const notApplicable = registry.filter((c) => c.group === group).length - rows.length;
              return (
                <section className="group" key={group} style={{ animationDelay: `${gi * 0.05}s` }}>
                  <div className="group-head">
                    <h2>{GROUP_LABELS[group]}</h2>
                    <span className="tally">
                      {passed}/{rows.length} clean{notApplicable > 0 && <> · {notApplicable} n/a</>}
                    </span>
                  </div>
                  <p className="group-intro">{GROUP_INTROS[group]}</p>
                  <div className="group-list">
                    {rows.map((row) => {
                      const findings = findingsByCheck.get(row.check) ?? [];
                      const errs = findings.filter((f) => f.severity === "error").length;
                      const warns = findings.filter((f) => f.severity === "warning").length;
                      const def = checkRegistry[row.check];
                      return (
                        <details className="check" key={row.check} open={row.status === "failed" || row.status === "errored"}>
                          <summary>
                            <span className={`glyph ${row.status}`}>{GLYPHS[row.status]}</span>
                            <span className="check-title">
                              {def?.title ?? row.check}
                              <span className="cname">
                                {row.check} · {def?.rule}
                              </span>
                            </span>
                            <span className="limit-chip">
                              {row.measured && <span className="measured-val">{row.measured}</span>}
                              {row.measured && limitFor(row.check, resolvedCategory, hides) && <span className="limit-sep"> — </span>}
                              {limitFor(row.check, resolvedCategory, hides) ?? ""}
                            </span>
                            {errs > 0 ? (
                              <span className="count-chip err">{errs} error{errs > 1 ? "s" : ""}</span>
                            ) : warns > 0 ? (
                              <span className="count-chip wrn">{warns} warning{warns > 1 ? "s" : ""}</span>
                            ) : (
                              <span className="count-chip ok">{row.status === "passed" ? "ok" : row.status}</span>
                            )}
                          </summary>
                          <div className="check-body">
                            <p className="explain">{explanations[row.check]}</p>
                            {details[row.check] && (
                              <p className="how">
                                <span className="fix-label">How it's checked</span>
                                {details[row.check]}{" "}
                                <a className="src-link" href={sourceLinks[row.check]} target="_blank" rel="noreferrer">
                                  source ↗
                                </a>
                              </p>
                            )}
                            {row.status === "skipped" && <p className="skip-note">skipped — {row.skipReason}</p>}
                            {row.status === "errored" && <p className="skip-note">check crashed — {row.skipReason}</p>}
                            {(row.status === "failed" || row.status === "warning") && fixes[row.check] && (
                              <p className="fix-hint">
                                <span className="fix-label">How to fix</span>
                                {fixes[row.check]}
                              </p>
                            )}
                            {findings.map((f, fi) => (
                              <div className={`finding ${f.severity}`} key={fi}>
                                <p className="msg">{f.message}</p>
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
                                  <a href={f.docs} target="_blank" rel="noreferrer">
                                    docs ↗
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            <footer className="foot">
              Checks that don't apply to this item (wrong item type, or metadata a bare .glb can't carry) aren't shown — that's
              why fewer than {registry.length} appear. Rendering &amp; AI checks arrive with the renderer. Nothing leaves this
              page: files are read and validated locally.
            </footer>
          </main>
        </div>
      )}
    </div>
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
      <h1>Drop a wearable or emote</h1>
      <p>Every rule from the rule book, checked instantly.</p>
      <div className="formats">
        <span className="chip">.zip — Builder export</span>
        <span className="chip">.glb — bare model</span>
      </div>
      <p className="privacy">runs 100% in your browser — nothing is uploaded</p>
    </label>
    <form
      className="reference"
      onSubmit={(e) => {
        e.preventDefault();
        if (reference.trim()) onReference(reference);
      }}
    >
      <input
        className="reference-input"
        placeholder="…or paste a shop item URL (decentraland.org/shop/item/0x…/N) or URN"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        aria-label="marketplace URL or URN"
      />
      <button className="reference-btn" type="submit">Analyze</button>
    </form>
    {samples.length > 0 && (
      <div className="samples">
        <span className="samples-label">or try a published item</span>
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
        <span className="eui-overline">verdict</span>
        {result.passed === true && <span className="stamp pass">Passed</span>}
        {result.passed === false && <span className="stamp fail">Failed</span>}
        {result.passed === null && <span className="stamp none">{bare ? "Advisory — no verdict" : "Incomplete"}</span>}
      </div>
      <div className="verdict-facts">
        <div>
          <span className={`n${errors ? " err" : ""}`}>{errors}</span> errors ·{" "}
          <span className={`n${warnings ? " wrn" : ""}`}>{warnings}</span> warnings
        </div>
        <div>
          <span className="n">{checked}</span> of {registry.length} checks apply
          {result.summary.skipped > 0 && <> · {result.summary.skipped} skipped</>}
        </div>
      </div>
    </div>
  );
}
