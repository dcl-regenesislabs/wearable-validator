import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";

/**
 * Official wearable-preview iframe, fed the local file via postMessage blobs —
 * the exact pixels the checks judged, never an upload. Best-effort: if the
 * hosted previewer can't load the item, the panel says so and the checks
 * remain the source of truth.
 */
const PREVIEW_URL = "https://wearable-preview.decentraland.org/?disableBackground=1";
const BODY_SHAPES = ["urn:decentraland:off-chain:base-avatars:BaseMale", "urn:decentraland:off-chain:base-avatars:BaseFemale"];

interface PreviewProps {
  file: { name: string; bytes?: Uint8Array; isBareGlb: boolean; files?: Map<string, Uint8Array>; metadata?: unknown };
  kind: "wearable" | "emote";
  category?: string;
}

type State = "loading" | "ready" | "failed";

export function Preview({ file, kind, category }: PreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    let cancelled = false;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const timeout = setTimeout(() => setState((s) => (s === "loading" ? "failed" : s)), 12000);

    async function send() {
      let item: Record<string, unknown>;
      try {
        item = await buildItemWithBlobs(file, kind, category);
      } catch {
        if (!cancelled) setState("failed");
        return undefined;
      }
      if (cancelled) return undefined;
      const onMessage = (event: MessageEvent) => {
        if (cancelled) return;
        if (event.source !== iframe!.contentWindow) return;
        const type = (event.data as { type?: string })?.type;
        if (type === "ready") {
          iframe!.contentWindow?.postMessage({ type: "update", payload: { options: { blob: item } } }, "*");
        } else if (type === "load") {
          if (!cancelled) setState("ready");
        } else if (type === "error") {
          if (!cancelled) setState("failed");
        }
      };
      window.addEventListener("message", onMessage);
      // The iframe may have signalled ready before our listener attached — nudge it.
      iframe!.contentWindow?.postMessage({ type: "update", payload: { options: { blob: item } } }, "*");
      return () => window.removeEventListener("message", onMessage);
    }

    const cleanup = send();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      void cleanup.then((fn) => fn?.(), () => {});
    };
  }, [file, kind, category]);

  return (
    <div className="card">
      <div className="card-head"><span className="eui-overline">preview</span></div>
      <iframe ref={iframeRef} className="preview-frame" src={PREVIEW_URL} title="wearable preview" allow="autoplay" />
      {state === "loading" && <p className="preview-note">loading previewer…</p>}
      {state === "failed" && <p className="preview-note">previewer couldn't load this item — the checks are unaffected</p>}
    </div>
  );
}

async function buildItemWithBlobs(
  file: { name: string; bytes?: Uint8Array; isBareGlb: boolean; files?: Map<string, Uint8Array>; metadata?: unknown },
  kind: "wearable" | "emote",
  category?: string
): Promise<Record<string, unknown>> {
  let files = new Map<string, Uint8Array>();
  let mainFile = "model.glb";
  let itemCategory = category ?? "hat";
  let loop = false;

  if (file.files) {
    files = file.files;
    const meta = file.metadata as {
      data?: { category?: string; representations?: { mainFile?: string }[] };
      emoteDataADR74?: { loop?: boolean; representations?: { mainFile?: string }[] };
    };
    itemCategory = meta?.data?.category ?? itemCategory;
    loop = meta?.emoteDataADR74?.loop ?? false;
    const declaredMain = (meta?.data?.representations ?? meta?.emoteDataADR74?.representations)?.[0]?.mainFile;
    if (declaredMain && files.has(declaredMain)) mainFile = declaredMain;
    else {
      const firstGlb = [...files.keys()].find((p) => p.endsWith(".glb"));
      if (firstGlb) mainFile = firstGlb;
    }
  } else if (file.isBareGlb) {
    files.set("model.glb", file.bytes!);
  } else {
    const zip = await JSZip.loadAsync(file.bytes!);
    for (const [path, entry] of Object.entries(zip.files)) {
      if (!entry.dir) files.set(path, await entry.async("uint8array"));
    }
    const manifestBytes = files.get(kind === "emote" ? "emote.json" : "wearable.json");
    if (manifestBytes) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
          category?: string;
          play_mode?: string;
          data?: { category?: string; representations?: { mainFile?: string }[] };
        };
        itemCategory = parsed.data?.category ?? parsed.category ?? itemCategory;
        loop = parsed.play_mode === "loop";
        const declaredMain = parsed.data?.representations?.[0]?.mainFile;
        if (declaredMain && files.has(declaredMain)) mainFile = declaredMain;
      } catch {
        // fall through to first-glb detection
      }
    }
    if (!files.has(mainFile)) {
      const firstGlb = [...files.keys()].find((p) => p.endsWith(".glb"));
      if (firstGlb) mainFile = firstGlb;
    }
  }

  const contents = [...files.entries()].map(([key, bytes]) => ({
    key,
    blob: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer])
  }));
  const representation = {
    bodyShapes: BODY_SHAPES,
    mainFile,
    contents,
    overrideHides: [],
    overrideReplaces: []
  };
  const base = {
    id: "urn:decentraland:off-chain:preview:item",
    name: file.name,
    description: "",
    thumbnail: "",
    image: "",
    i18n: [{ code: "en", text: file.name }],
    rarity: "common"
  };

  if (kind === "emote") {
    return { ...base, emoteDataADR74: { category: "dance", loop, tags: [], representations: [representation] } };
  }
  return { ...base, data: { category: itemCategory, hides: [], replaces: [], tags: [], representations: [representation] } };
}
