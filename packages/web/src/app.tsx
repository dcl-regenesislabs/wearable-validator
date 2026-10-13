import { useCallback, useEffect, useRef, useState } from "react";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { urnFrom, urnUrl } from "./route.js";
import { ValidateView } from "./validate-view.js";

/** The shell: top bar (wordmark, rules version), the `?urn=` URL state and the full-window drop catcher. */

export function App() {
  const [urn, setUrn] = useState<string | null>(() => urnFrom(location.search));
  const [dragging, setDragging] = useState(false);
  const [incoming, setIncoming] = useState<{ file: File; seq: number } | null>(null);
  const seq = useRef(0);

  const navigate = useCallback((next: string | null) => {
    const url = urnUrl(next);
    if (url !== location.pathname + location.search) history.pushState({}, "", url);
    setUrn(next);
  }, []);

  useEffect(() => {
    const onPop = () => setUrn(urnFrom(location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // drag anywhere: the catcher shows while a file is over the window and takes the drop
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          <span className="eui-overline">decentraland</span>
          <span className="title">Wearable Validator</span>
        </div>
        <div className="topbar-status">
          <span className="eui-overline rules-version">rules v{manifest.version}</span>
        </div>
      </header>

      <section>
        <ValidateView urn={urn} incoming={incoming} navigate={navigate} />
      </section>

      <div className={`eui-prefab-drop${dragging ? " over" : ""}`} hidden={!dragging} aria-hidden="true">
        <div className="hint">Drop to validate</div>
      </div>
    </div>
  );
}
