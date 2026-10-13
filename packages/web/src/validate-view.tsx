import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { inputTooLarge, fetchCatalystItem, manifest, parseItemReference, validate, type ProgressEvent, type Result } from "@dcl-regenesislabs/wearable-validator";
import { formatBytes, inputKind, isGlb, isPng, itemBytes, zipRuleContext, type Loaded, type Sample } from "./item.js";
import { Preview } from "./preview.js";
import { codeSteps, type Step } from "./progress.js";
import { CODE_CHECK_COUNT, Results } from "./results.js";
import { Notice } from "./rules.js";
import { Stepper } from "./stepper.js";

/**
 * The page: the landing drop zone, the progress view while a file is read and its checks run, then the results —
 * rail (item, preview) and main (verdict, rule groups). Everything runs in the browser.
 */

const CATEGORIES = Object.keys(manifest.triangles.perCategory).concat(manifest.facialCategories);

interface Reading {
  label: string;
  detail?: string;
}

export interface ValidateViewProps {
  /** `?urn=` of the URL: the catalyst item to show; null clears a shown one on back/forward. */
  urn: string | null;
  /** A file dropped anywhere on the page. */
  incoming: { file: File; seq: number } | null;
  /** Puts the shown catalyst item in the URL, or clears it with null. */
  navigate: (urn: string | null) => void;
}

export function ValidateView({ urn, incoming, navigate }: ValidateViewProps) {
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
        const item = await fetchCatalystItem(candidates, {
          onProgress: ({ text, done, total }) => {
            if (id === loadSeq.current) setReading({ label: "Fetching the published item", detail: total === undefined ? text : `${done ?? 0}/${total} files` });
          }
        });
        if (id !== loadSeq.current) return;
        if (updateHistory) navigate(item.urn);
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
      navigate(null);
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
      navigate(null);
      setReading({ label: `Reading ${file.name}`, detail: formatBytes(file.size) });
      try {
        if (file.size > manifest.fileSize.maxInputBytes) throw new Error(inputTooLarge(file.size));
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
    navigate(null);
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

  // ── derived ─────────────────────────────────────────────────────────────────
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
            <Results
              key={loaded.name + (loaded.bytes?.length ?? loaded.files?.size ?? 0)}
              scope="validate"
              result={result}
              filter={filter}
              onFilter={setFilter}
              item={{
                metadata: loaded.metadata ?? loaded.zipMetadata,
                metadataSource: loaded.metadata !== undefined ? "Published entity" : loaded.zipMetadataSource,
                category: resolvedCategory,
                hides
              }}
              bare={loaded.isBareGlb}
              footer={
                <footer className="foot">
                  Checks that don't apply to this item (wrong item type, or metadata a bare .glb can't carry) aren't shown — that's
                  why fewer than {CODE_CHECK_COUNT} appear. Every check runs in your browser: your file never leaves this page.
                </footer>
              }
            />
          </main>
        </div>
      )}
    </div>
  );
}

interface LandingProps {
  onFile: (file: File) => void;
  samples: Sample[];
  onSample: (sample: Sample) => void;
  onReference: (raw: string) => void;
  /** The last load's error, shown right under the drop zone the creator just used. */
  notice?: ReactNode;
}

function Landing({ onFile, samples, onSample, onReference, notice }: LandingProps) {
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
      <p className="landing-note">Every check runs in your browser: your file never leaves this page.</p>
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
    </div>
  );
}
