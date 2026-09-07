import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  validate,
  checks as checkRegistry,
  explanations,
  manifest,
  registry,
  type Finding,
  type Group,
  type Result
} from "@dcl-regenesislabs/wearable-validator";
import { Preview } from "./preview.js";

const GROUP_LABELS: Record<Group, string> = {
  files: "Files & metadata",
  model: "3D model",
  emote: "Animation",
  rendering: "Rendering",
  content: "Content"
};
const GROUP_ORDER: Group[] = ["files", "model", "emote", "content"];
const CATEGORIES = Object.keys(manifest.triangles.perCategory).concat(manifest.facialCategories);
const GLYPHS: Record<string, string> = { passed: "✓", failed: "✕", warning: "!", skipped: "○", errored: "‼" };

interface Loaded {
  name: string;
  bytes: Uint8Array;
  isBareGlb: boolean;
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [crash, setCrash] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const runSeq = useRef(0);

  const run = useCallback(async (file: Loaded, cat: string) => {
    const id = ++runSeq.current;
    setRunning(true);
    setCrash(null);
    try {
      const res = await validate(file.bytes, cat ? { category: cat } : {});
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

  const onFile = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isBareGlb = bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
      const next: Loaded = { name: file.name, bytes, isBareGlb };
      setLoaded(next);
      setResult(null);
      setCategory("");
      await run(next, "");
    },
    [run]
  );

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

      {!loaded && <Dropzone dragging={dragging} onFile={onFile} />}
      {loaded && running && !result && <div className="spin" role="status" aria-label="validating" />}
      {crash && (
        <div className="card crash" role="alert">
          <div className="card-head"><span className="eui-overline">error</span></div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}>{crash}</p>
            <button className="reset-btn" onClick={() => { setLoaded(null); setResult(null); setCrash(null); }}>
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
                  <dd>{(loaded.bytes.length / 1048576).toFixed(2)} MB</dd>
                  <dt>input</dt>
                  <dd>{loaded.isBareGlb ? "bare .glb — advisory run" : loaded.name.endsWith(".zip") ? "zip package" : "file"}</dd>
                  <dt>type</dt>
                  <dd>{kind}</dd>
                </dl>
                {loaded.isBareGlb && (
                  <select
                    className="category"
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      void run(loaded, e.target.value);
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
            <Preview key={loaded.name + loaded.bytes.length} file={loaded} kind={kind} category={category || undefined} />
            <button className="reset-btn" onClick={() => { setLoaded(null); setResult(null); }}>
              Validate another file
            </button>
          </aside>

          <main>
            <Verdict result={result} bare={loaded.isBareGlb} />
            {GROUP_ORDER.map((group, gi) => {
              const rows = result.checks.filter((c) => c.group === group);
              if (rows.length === 0) return null;
              const passed = rows.filter((r) => r.status === "passed").length;
              return (
                <section className="group" key={group} style={{ animationDelay: `${gi * 0.05}s` }}>
                  <div className="group-head">
                    <h2>{GROUP_LABELS[group]}</h2>
                    <span className="tally">
                      {passed}/{rows.length} clean
                    </span>
                  </div>
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
                            {row.status === "skipped" && <p className="skip-note">skipped — {row.skipReason}</p>}
                            {row.status === "errored" && <p className="skip-note">check crashed — {row.skipReason}</p>}
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
                                    how to fix ↗
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
              Deterministic checks only — rendering &amp; AI checks arrive with the renderer. Nothing leaves this page: files are
              read and validated locally.
            </footer>
          </main>
        </div>
      )}
    </div>
  );
}

function Dropzone({ dragging, onFile }: { dragging: boolean; onFile: (f: File) => void }) {
  return (
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
          <span className="n">{checked}</span> checks ran
          {result.summary.skipped > 0 && <> · {result.summary.skipped} skipped</>}
        </div>
      </div>
    </div>
  );
}
