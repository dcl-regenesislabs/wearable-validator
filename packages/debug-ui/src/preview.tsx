import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";

/**
 * Official wearable-preview iframe, fed the local file via postMessage blobs —
 * the exact pixels the checks judged, never an upload. Marketplace-style
 * controls: pick an avatar animation for wearables, play/pause for emote
 * items, switch body shape. Best-effort: if the hosted previewer can't load
 * the item, the panel says so and the checks remain the source of truth.
 */
const PREVIEW_URL = "https://wearable-preview.decentraland.org/?disableBackground=1";
const MALE = "urn:decentraland:off-chain:base-avatars:BaseMale";
const FEMALE = "urn:decentraland:off-chain:base-avatars:BaseFemale";
/** Built-in avatar animations the previewer ships (PreviewEmote in @dcl/schemas). */
// Verified against the previewer CDN (…/wearable-preview/2.19.0/emotes/<name>.glb) — do not add unprobed names.
const AVATAR_EMOTES = ["idle", "walk", "run", "jump", "clap", "dance", "dab", "fashion", "fashion-2", "fashion-3", "fashion-4", "fist-pump", "head-explode", "money", "love"];

interface PreviewProps {
  file: { name: string; bytes?: Uint8Array; isBareGlb: boolean; files?: Map<string, Uint8Array>; metadata?: unknown };
  kind: "wearable" | "emote";
  category?: string;
}

type State = "loading" | "ready" | "failed";

export function Preview({ file, kind, category }: PreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<Record<string, unknown> | null>(null);
  const requestId = useRef(0);
  const [state, setState] = useState<State>("loading");
  const [bodyShape, setBodyShape] = useState<"male" | "female">("male");
  const [avatarEmote, setAvatarEmote] = useState("idle");
  const [playing, setPlaying] = useState(true);

  const sendUpdate = useCallback(
    (shape: "male" | "female", emote: string) => {
      const item = itemRef.current;
      const iframe = iframeRef.current;
      if (!item || !iframe?.contentWindow) return;
      const options: Record<string, unknown> = { blob: item, profile: "default", bodyShape: shape === "male" ? MALE : FEMALE };
      if (kind === "wearable") options.emote = emote;
      iframe.contentWindow.postMessage({ type: "update", payload: { options } }, "*");
    },
    [kind]
  );

  const sendEmoteCommand = useCallback((method: "play" | "pause" | "goTo", params: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "controller_request", payload: { id: ++requestId.current, namespace: "emote", method, params } },
      "*"
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const timeout = setTimeout(() => setState((s) => (s === "loading" ? "failed" : s)), 15000);

    async function send() {
      let item: Record<string, unknown>;
      try {
        item = await buildItemWithBlobs(file, kind, category);
      } catch {
        if (!cancelled) setState("failed");
        return undefined;
      }
      if (cancelled) return undefined;
      itemRef.current = item;
      const onMessage = (event: MessageEvent) => {
        if (cancelled) return;
        if (event.source !== iframe!.contentWindow) return;
        const data = event.data as { type?: string; payload?: { type?: string } };
        if (data?.type === "ready") {
          sendUpdate(bodyShape, avatarEmote);
        } else if (data?.type === "load") {
          setState("ready");
        } else if (data?.type === "error") {
          setState("failed");
        } else if (data?.type === "emote_event") {
          if (data.payload?.type === "animationPlay") setPlaying(true);
          if (data.payload?.type === "animationPause" || data.payload?.type === "animationEnd") setPlaying(false);
        }
      };
      window.addEventListener("message", onMessage);
      // The iframe may have signalled ready before our listener attached — nudge it.
      sendUpdate(bodyShape, avatarEmote);
      return () => window.removeEventListener("message", onMessage);
    }

    const cleanup = send();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      void cleanup.then((fn) => fn?.(), () => {});
    };
    // shape/animation changes re-send via sendUpdate directly, not a full rebuild
  }, [file, kind, category]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card preview-card" ref={cardRef}>
      <div className="card-head">
        <span className="eui-overline">preview</span>
        <span className="head-spacer" />
        <button
          className="shape-btn"
          aria-label="toggle fullscreen"
          title="fullscreen"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void cardRef.current?.requestFullscreen();
          }}
        >
          ⛶
        </button>
        <div className="preview-shapes" role="group" aria-label="body shape">
          {(["male", "female"] as const).map((shape) => (
            <button
              key={shape}
              className={`shape-btn${bodyShape === shape ? " active" : ""}`}
              onClick={() => {
                setBodyShape(shape);
                sendUpdate(shape, avatarEmote);
              }}
            >
              {shape === "male" ? "M" : "F"}
            </button>
          ))}
        </div>
      </div>
      <iframe ref={iframeRef} className="preview-frame" src={PREVIEW_URL} title="wearable preview" allow="autoplay" />
      <div className="preview-controls">
        {kind === "wearable" ? (
          <select
            className="category preview-emote"
            value={avatarEmote}
            onChange={(e) => {
              setAvatarEmote(e.target.value);
              sendUpdate(bodyShape, e.target.value);
            }}
            aria-label="avatar animation"
          >
            {AVATAR_EMOTES.map((e) => (
              <option key={e} value={e}>
                animation: {e}
              </option>
            ))}
          </select>
        ) : (
          <div className="emote-buttons" role="group" aria-label="emote playback">
            <button className="shape-btn" onClick={() => sendEmoteCommand(playing ? "pause" : "play")}>
              {playing ? "⏸ pause" : "▶ play"}
            </button>
            <button
              className="shape-btn"
              onClick={() => {
                sendEmoteCommand("goTo", [0]);
                sendEmoteCommand("play");
              }}
            >
              ↺ restart
            </button>
          </div>
        )}
      </div>
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
    bodyShapes: [MALE, FEMALE],
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
