import { createRoot } from "react-dom/client";
import { Preview } from "../src/preview.js";
import "../src/styles.css";

interface PreviewEvent {
  type?: string;
  payload?: { type?: string; payload?: { length?: number } };
}

const output = document.querySelector<HTMLPreElement>("#result")!;


function waitForEvent(matches: (event: PreviewEvent) => boolean, action?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for the previewer's playback event (${output.textContent}).`));
    }, 30000);
    function onMessage(event: MessageEvent<PreviewEvent>) {
      if (event.source !== document.querySelector("iframe")?.contentWindow || !matches(event.data)) return;
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      requestAnimationFrame(() => resolve());
    }
    window.addEventListener("message", onMessage);
    action?.();
  });
}

async function run() {
  const response = await fetch("/samples/emote.zip");
  if (!response.ok) throw new Error("Could not load the bundled emote.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitForEvent(event => event.type === "load", () => {
    createRoot(document.querySelector("#preview")!).render(<Preview file={{ name: "emote.zip", bytes, isBareGlb: false }} kind="emote" />);
  });
  await waitForEvent(event => event.payload?.type === "animation_playing" && (event.payload.payload?.length ?? 0) > 0.5);
  const buttons = document.querySelectorAll<HTMLButtonElement>(".emote-buttons button");
  const toggle = buttons[0]!;
  const restart = buttons[1]!;
  output.textContent = "Testing pause, resume, and restart…";
  await waitForEvent(event => event.type === "emote_event" && event.payload?.type === "animation_pause", () => toggle.click());
  if (!toggle.textContent?.includes("play")) throw new Error("Pause did not change the button to Play.");
  output.textContent = "Testing resume…";
  await waitForEvent(event => event.type === "emote_event" && event.payload?.type === "animation_play", () => toggle.click());
  if (!toggle.textContent?.includes("pause")) throw new Error("Play did not change the button to Pause.");
  await waitForEvent(event => event.payload?.type === "animation_playing" && (event.payload.payload?.length ?? 0) > 0.5);
  output.textContent = "Testing restart from a paused position…";
  await waitForEvent(event => event.payload?.type === "animation_pause", () => toggle.click());
  await waitForEvent(event => event.payload?.type === "animation_playing" && (event.payload.payload?.length ?? Infinity) < 0.1, () => restart.click());
  await waitForEvent(event => event.payload?.type === "animation_playing" && (event.payload.payload?.length ?? 0) > 0.2);
  if (!toggle.textContent?.includes("pause")) throw new Error("Restart did not resume playback.");
  output.textContent = "PASS: Pause stops playback, Play resumes, and Restart rewinds and plays from a paused state.";
}

run().catch((error: unknown) => {
  output.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
});
