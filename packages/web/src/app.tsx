import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { HistoryView } from "./history-view.js";
import { routeFrom, routeUrl, type Route, type Tab } from "./run-list.js";
import { useServer } from "./server.js";
import { ValidateView } from "./validate-view.js";

/**
 * The shell: top bar (wordmark, Validate / History tabs, the run server's status), the URL state both tabs share,
 * and the full-window drop catcher. Both tabs stay mounted so a running visual review survives a tab switch.
 */

const TABS: { key: Tab; label: string }[] = [
  { key: "validate", label: "Validate" },
  { key: "history", label: "History" }
];

export function App() {
  const server = useServer();
  const [route, setRoute] = useState<Route>(() => routeFrom(location.search));
  const [dragging, setDragging] = useState(false);
  const [incoming, setIncoming] = useState<{ file: File; seq: number } | null>(null);
  const seq = useRef(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const routeRef = useRef(route);
  routeRef.current = route;

  const navigate = useCallback((patch: Partial<Route>) => {
    const next = { ...routeRef.current, ...patch };
    if (next.run) next.tab = "history";
    const url = routeUrl(next);
    if (url !== location.pathname + location.search) history.pushState({}, "", url);
    routeRef.current = next;
    setRoute(next);
  }, []);

  // one owner for back/forward: the URL is the state, both tabs read it from here
  useEffect(() => {
    const onPop = () => setRoute(routeFrom(location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // drag anywhere: the catcher shows while a file is over the window and takes the drop on every page
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) setIncoming({ file, seq: ++seq.current });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length];
    navigate({ tab: next.key, run: null });
    tabRefs.current[TABS.indexOf(next)]?.focus();
  };

  const status = serverStatus(server.known, server.capabilities?.renderer ?? false, server.capabilities?.reviewer);
  const signedIn = server.owner && server.owner !== "local" ? server.owner : null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          <span className="eui-overline">decentraland</span>
          <span className="title">Wearable Validator</span>
        </div>
        <div className="eui-studio-tabbar" role="tablist" aria-label="Pages">
          {TABS.map((tab, index) => {
            const on = route.tab === tab.key;
            return (
              <span key={tab.key} className={`eui-studio-tab${on ? " on" : ""}`}>
                <button
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  type="button"
                  className="lbl"
                  role="tab"
                  id={`tab-${tab.key}`}
                  aria-selected={on}
                  aria-controls={`panel-${tab.key}`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => navigate({ tab: tab.key, run: null })}
                  onKeyDown={(e) => onTabKey(e, index)}
                >
                  {tab.label}
                  {tab.key === "history" && server.runs.length > 0 && (
                    <>
                      <span className="ct" aria-hidden="true">{server.runs.length}</span>
                      <span className="eui-sr-only"> ({server.runs.length} {server.runs.length === 1 ? "run" : "runs"})</span>
                    </>
                  )}
                </button>
              </span>
            );
          })}
        </div>
        <div className="topbar-status">
          <span className={`eui-ds-chip ${status.tone} xs`}>
            <span className="ico" aria-hidden="true">
              <i className={`dot ${status.tone}`} />
            </span>
            <span className="txt">Run server: {status.label}</span>
          </span>
          <span className="eui-overline rules-version">rules v{manifest.version}</span>
          {signedIn && <span className="signed-in">Signed in as <b>{signedIn}</b></span>}
        </div>
      </header>

      <section role="tabpanel" id="panel-validate" aria-labelledby="tab-validate" hidden={route.tab !== "validate"}>
        <ValidateView server={server} urn={route.urn} incoming={incoming} navigate={navigate} />
      </section>
      <section role="tabpanel" id="panel-history" aria-labelledby="tab-history" hidden={route.tab !== "history"}>
        <HistoryView server={server} runId={route.tab === "history" ? route.run : null} onOpen={(id) => navigate({ tab: "history", run: id })} onBack={() => navigate({ tab: "history", run: null })} />
      </section>

      <div className={`eui-prefab-drop${dragging ? " over" : ""}`} hidden={!dragging} aria-hidden="true">
        <div className="hint">Drop to validate</div>
      </div>
    </div>
  );
}

function serverStatus(known: boolean, renderer: boolean, reviewer: "pi" | "dry-run" | "none" | undefined): { label: string; tone: string } {
  if (!known) return { label: "not connected", tone: "soon" };
  if (renderer && reviewer === "pi") return { label: "renderer + model", tone: "live" };
  if (renderer) return { label: "renderer only", tone: "" };
  return { label: "no renderer", tone: "" };
}
