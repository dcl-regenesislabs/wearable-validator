/**
 * Phase-0 lab probe: the observation matrix that qualified the headless previewer.
 * Previous hop: src/rendering.ts owns Chromium, asset pinning and the wire protocol — this
 * script only drives those exports and keeps its page-level diagnostics (CDP GPU info,
 * in-frame navigator.gpu, console/pageerror, .error overlay, events.json).
 * Next hop: docs/experiments/renderer.md records what was observed.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { platform, arch } from "node:os";
import type { Browser, Page } from "playwright-core";
import { decode } from "fast-png";
import { manifest } from "../../packages/wearable-validator/src/manifest/index.js";
import build from "../../packages/wearable-validator/src/rendering-build.json" with { type: "json" };
import { loadInput } from "../../packages/wearable-validator/src/loader.js";
import {
  PREVIEW_HOST_URL, PREVIEW_URL, PreviewLoadError, launchChromium, mountPreview, pageSession, previewItem, previewUrl,
  readLocalBuild, requestPreview, routeAssets, screenshot, updatePreview, waitForLoad
} from "../../packages/wearable-validator/src/rendering.js";
import type { RenderInput } from "../../packages/wearable-validator/src/types.js";

const settings = manifest.rendering;
const lab = manifest.rendering.probe;
const root = resolve(import.meta.dirname, "../..");
const { values } = parseArgs({ options: {
  engine: { type: "string", default: "unity" },
  gpu: { type: "string", default: "software" },
  executable: { type: "string" },
  "renderer-build": { type: "string" },
  out: { type: "string", default: join(root, "tools/artifacts") },
  headed: { type: "boolean", default: false }
} });
const engine = values.engine === "unity" || values.engine === "babylon" ? values.engine : undefined;
if (!engine) throw new Error("Choose --engine unity or --engine babylon.");
if (values.gpu !== "software" && values.gpu !== "hardware") throw new Error("Choose --gpu software or --gpu hardware.");
if (values["renderer-build"] && values.engine !== "unity") throw new Error("A local renderer build requires --engine unity.");
const gpu = values.gpu;

interface Observation { name: string; status: "passed" | "observed" | "failed" | "not-run"; detail: string; elapsedMs?: number }
interface Capture { name: string; width: number; height: number; sha256: string; pixelsSha256: string }
interface Asset { url: string; sha256: string; bytes: number }

/** Sample zips go through the package loader so the probe renders exactly what validate() would hand the renderer. */
async function readFixture(path: string) {
  const bytes = await readFile(path);
  const loaded = await loadInput(bytes, {});
  const ctx = loaded.ctx;
  if (!ctx || !ctx.category || !ctx.item.representations?.length) throw new Error(`${path} must be a Builder zip with a category and representations.`);
  const input: RenderInput = { files: ctx.files, item: ctx.item, itemType: ctx.itemType, category: ctx.category };
  return { item: previewItem(input), shapes: ctx.item.representations.flatMap((rep) => rep.bodyShapes), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function main(): Promise<void> {
  const localAssets = values["renderer-build"] ? await readLocalBuild(values["renderer-build"]) : undefined;
  await mkdir(values.out!, { recursive: true });
  const out = await mkdtemp(join(resolve(values.out!), "renderer-"));
  const url = previewUrl(engine);
  const observations: Observation[] = [];
  const captures: Capture[] = [];
  const assets: Asset[] = [];
  const diagnostics: string[] = [];
  const assetTasks: Promise<void>[] = [];
  const started = performance.now();
  let page: Page | undefined;
  let browser: Browser | undefined;
  let browserVersion = "not launched";
  let fixtureDigests: Record<string, string> = {};
  let actualRenderer = "unknown";
  let gpuInfo: unknown;
  let webgpuAdapter: unknown;
  const stop = () => { void browser?.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(() => {
    diagnostics.push("The experiment exceeded its total time budget.");
    stop();
  }, settings.timeoutMs);

  async function probe(name: string, run: () => Promise<string>, inspect = false): Promise<boolean> {
    const start = performance.now();
    try {
      const detail = await run();
      const status = inspect ? "observed" : "passed";
      observations.push({ name, status, detail, elapsedMs: Math.round(performance.now() - start) });
      console.log(`${status.toUpperCase()} ${name}: ${detail}`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      observations.push({ name, status: "failed", detail, elapsedMs: Math.round(performance.now() - start) });
      console.log(`FAIL ${name}: ${detail}`);
      return false;
    }
  }

  async function capture(name: string): Promise<Capture> {
    const { bytes } = await screenshot(pageSession(page!, settings));
    const png = decode(bytes);
    const result = {
      name, width: png.width, height: png.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      pixelsSha256: createHash("sha256").update(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)).digest("hex")
    };
    await writeFile(join(out, `${name}.png`), bytes);
    captures.push(result);
    return result;
  }

  try {
    const launched: Browser = await launchChromium({ gpu, headed: values.headed, executablePath: values.executable });
    browser = launched;
    browserVersion = launched.version();
    const cdp = await launched.newBrowserCDPSession();
    gpuInfo = (await cdp.send("SystemInfo.getInfo")).gpu;
    await cdp.detach();
    const context = await launched.newContext({ viewport: { width: settings.imageSizePx, height: settings.imageSizePx }, serviceWorkers: "block" });
    // no local build = the deployed baseline: routeAssets still pins the wrapper and blocks trackers
    const assetHealth = await routeAssets(context, localAssets);
    page = await context.newPage();
    page.setDefaultTimeout(settings.commandTimeoutMs);
    page.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") diagnostics.push(message.text());
    });
    page.on("response", (response) => {
      if (!response.ok() || !response.url().startsWith("https://cdn.decentraland.org/")) return;
      assetTasks.push(response.body().then((bytes) => {
        assets.push({ url: response.url(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
      }).catch((error) => { diagnostics.push(`Asset digest unavailable: ${response.url()}: ${String(error)}`); }));
    });
    console.log(`Renderer probe: ${values.engine}, ${gpu}, Chromium ${browserVersion}\nEvidence: ${out}`);
    await mountPreview(page, url, settings.imageSizePx);
    const loaded = await probe("requested-renderer", async () => {
      const event = await waitForLoad(page!, 0, settings.loadTimeoutMs);
      assetHealth.assertHealthy();
      actualRenderer = event.payload?.renderer ?? "unreported";
      const frame = page!.frames().find((frame) => frame.url().startsWith(PREVIEW_URL));
      // flags request a backend; the probe proves it with navigator.gpu.requestAdapter() inside the frame (architecture swiftshader, isFallbackAdapter)
      webgpuAdapter = await frame?.evaluate(async () => {
        const gpu = Reflect.get(navigator, "gpu") as { requestAdapter(): Promise<{ info: { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter?: boolean } } | null> } | undefined;
        const adapter = await gpu?.requestAdapter();
        if (!adapter) return null;
        const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
        return { vendor, architecture, device, description, isFallbackAdapter };
      });
      const hasUnityCanvas = await page!.locator("iframe").contentFrame().locator("#unity-canvas").count() > 0;
      if (values.engine === "unity" && (actualRenderer !== "unity" || !hasUnityCanvas)) {
        throw new Error(`Unity was requested but the previewer loaded ${actualRenderer}. WebGPU fallback is not Unity evidence.`);
      }
      return `Loaded ${actualRenderer}; Unity canvas: ${hasUnityCanvas}.`;
    });
    if (!loaded) return;

    await requestPreview(page, "emote", "pause", [], settings.commandTimeoutMs);
    await page.waitForTimeout(settings.settleMs);
    const screenshotsWork = await probe("screenshot-size", async () => {
      const image = await capture("baseline");
      if (image.width !== settings.imageSizePx || image.height !== settings.imageSizePx) {
        throw new Error(`Requested ${settings.imageSizePx} square; received ${image.width}×${image.height}.`);
      }
      return `${image.width}×${image.height} decoded PNG.`;
    });
    if (!screenshotsWork) return;
    const wearable = await readFixture(join(root, "packages/debug-ui/public/samples/upper_body.zip"));
    const emote = await readFixture(join(root, "packages/debug-ui/public/samples/emote.zip"));
    fixtureDigests = { wearable: wearable.sha256, emote: emote.sha256 };
    await writeFile(join(out, "fixture-metadata.json"), JSON.stringify([wearable.item, emote.item], (key, value: unknown) => key === "base64" ? "[local bytes omitted]" : value, 2));
    for (const [index, bodyShape] of wearable.shapes.entries()) {
      await probe(`representation-${index}`, async () => {
        await updatePreview(page!, wearable.item, { bodyShape, type: "avatar", profile: settings.profile }, settings.loadTimeoutMs);
        await requestPreview(page!, "emote", "pause", [], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        await capture(`worn-${index}`);
        return `${bodyShape}; preserved declared files. Inspect the capture against fixture-metadata.json.`;
      }, true);
    }
    await probe("chroma-skin", async () => {
      await updatePreview(page!, wearable.item, { skin: lab.chromaSkin, type: "avatar" }, settings.loadTimeoutMs);
      await requestPreview(page!, "emote", "pause", [], settings.commandTimeoutMs);
      await page!.waitForTimeout(settings.settleMs);
      await capture("chroma");
      return "Skin override accepted; inspect exposed skin in chroma.png. Pixel semantics are not asserted.";
    }, true);
    await probe("item-alone", async () => {
      await updatePreview(page!, wearable.item, { type: "wearable", skin: settings.skin }, settings.loadTimeoutMs);
      await requestPreview(page!, "emote", "pause", [], settings.commandTimeoutMs);
      await page!.waitForTimeout(settings.settleMs);
      await capture("item-alone");
      return "Item-only view requested; inspect whether the avatar is absent.";
    }, true);
    const stablePose = await probe("paused-emote-scrubbing", async () => {
      await updatePreview(page!, emote.item, { type: "avatar", skin: settings.skin }, settings.loadTimeoutMs);
      await requestPreview(page!, "emote", "pause", [], settings.commandTimeoutMs);
      const length = await requestPreview(page!, "emote", "getLength", [], settings.commandTimeoutMs);
      if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) throw new Error("The previewer did not report a positive emote duration.");
      const times = lab.poseFractions.map((fraction) => fraction * length);
      const sample = async (name: string, time: number) => {
        await requestPreview(page!, "emote", "goTo", [time], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        return capture(name);
      };
      const first = await sample("emote-a", times[0]);
      await page!.waitForTimeout(lab.pausedObservationMs);
      const held = await capture("emote-a-held");
      const second = await sample("emote-b", times[1]);
      const repeated = await sample("emote-a-repeated", times[0]);
      if (first.pixelsSha256 === second.pixelsSha256) throw new Error("Different scrub times produced identical pixels.");
      if (first.pixelsSha256 !== held.pixelsSha256) throw new Error("The paused capture changed during the observation interval.");
      if (first.pixelsSha256 !== repeated.pixelsSha256) throw new Error("Returning to the same time produced different pixels.");
      return `Distinct poses at ${times.join(", ")} seconds; held and repeated pixels match. This does not yet prove frame-exact timing.`;
    });
    if (stablePose) {
      // changeCameraPosition is RELATIVE radians: every move below is undone by sending its negative
      await probe("camera", async () => {
        const front = await capture("camera-before");
        await requestPreview(page!, "scene", "changeCameraPosition", [{ alpha: lab.cameraSideRadians }], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const side = await capture("camera-side");
        if (front.pixelsSha256 === side.pixelsSha256) throw new Error("Camera command returned success but pixels did not change.");
        await requestPreview(page!, "scene", "changeCameraPosition", [{ beta: -lab.cameraElevationRadians }], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const elevated = await capture("camera-elevated");
        if (side.pixelsSha256 === elevated.pixelsSha256) throw new Error("Elevation command returned success but pixels did not change.");
        await page!.waitForTimeout(lab.pausedObservationMs);
        const held = await capture("camera-elevated-held");
        if (elevated.pixelsSha256 !== held.pixelsSha256) throw new Error("The requested camera view continued moving.");
        await requestPreview(page!, "scene", "changeCameraPosition", [{ alpha: -lab.cameraSideRadians, beta: lab.cameraElevationRadians }], settings.commandTimeoutMs);
        await requestPreview(page!, "scene", "changeCameraPosition", [{ alpha: lab.cameraSideRadians, beta: -lab.cameraElevationRadians }], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const repeated = await capture("camera-elevated-repeated");
        if (elevated.pixelsSha256 !== repeated.pixelsSha256) throw new Error("Returning to the same camera view produced different pixels.");
        return "Azimuth and elevation changed pixels; held and repeated views match. Inspect framing and subject visibility.";
      }, true);
      await probe("camera-zoom", async () => {
        const before = await capture("zoom-before");
        await requestPreview(page!, "scene", "changeZoom", [lab.cameraZoomWorldUnits], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const zoomed = await capture("zoom-in");
        if (before.pixelsSha256 === zoomed.pixelsSha256) throw new Error("Zoom returned success but pixels did not change.");
        await requestPreview(page!, "scene", "changeZoom", [-lab.cameraZoomWorldUnits], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const restored = await capture("zoom-restored");
        if (before.pixelsSha256 !== restored.pixelsSha256) throw new Error("Reversing zoom did not restore the view.");
        return "Zoom changes the image and reversing it restores identical pixels.";
      });
      await probe("camera-pan", async () => {
        await requestPreview(page!, "scene", "panCamera", [{}], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const before = await capture("pan-origin");
        await requestPreview(page!, "scene", "panCamera", [lab.cameraPanTarget], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const shifted = await capture("pan-offset");
        if (before.pixelsSha256 === shifted.pixelsSha256) throw new Error("Pan returned success but pixels did not change.");
        await requestPreview(page!, "scene", "panCamera", [lab.cameraPanTarget], settings.commandTimeoutMs);
        await page!.waitForTimeout(settings.settleMs);
        const repeated = await capture("pan-repeated");
        if (shifted.pixelsSha256 !== repeated.pixelsSha256) throw new Error("Setting the same absolute pan target moved the view again.");
        return "Pan moves the view and repeating the absolute target preserves identical pixels.";
      });
    }
    // after an error load the pinned wrapper keeps its overlay (wrapper bug) — the renderer never continues past a load error; only the probe does, to observe it
    await probe("item-alone-error-recovery", async () => {
      let rejected = false;
      try {
        await updatePreview(page!, emote.item, { type: "wearable" }, settings.loadTimeoutMs);
      } catch (error) {
        if (!(error instanceof PreviewLoadError)) throw error;
        const detail = await page!.locator("iframe").contentFrame().locator(".error").textContent();
        if (!detail?.includes("requires exactly one local wearable")) throw error;
        rejected = true;
      }
      if (!rejected) throw new Error("An emote item-only request silently loaded instead of reporting an unsupported view.");
      await updatePreview(page!, wearable.item, { type: "avatar" }, settings.loadTimeoutMs);
      await requestPreview(page!, "emote", "pause", [], settings.commandTimeoutMs);
      await page!.waitForTimeout(settings.settleMs);
      await capture("recovered-wearable");
      const staleError = await page!.locator("iframe").contentFrame().locator(".error").count() > 0;
      observations.push({ name: "wrapper-error-reset", status: staleError ? "failed" : "passed", detail: staleError
        ? "The engine loaded the next item, but the pinned iframe still displays the previous error. Its load handler must clear the error state."
        : "The iframe clears the error after a valid upload." });
      return "The engine rejects an unsupported item-only request and accepts the next valid upload. The outer iframe replaces the specific error with generic text.";
    });
  } catch (error) {
    observations.push({ name: "harness", status: "failed", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(deadline);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(out, "last-page.png") }).catch(() => {});
      await writeFile(join(out, "events.json"), JSON.stringify(await page.evaluate(() => Reflect.get(window, "previewEvents") ?? []).catch(() => []), null, 2));
    }
    await browser?.close();
    await Promise.all(assetTasks);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    for (const name of ["requested-renderer", "screenshot-size", "representation-0", "representation-1", "chroma-skin", "item-alone", "paused-emote-scrubbing", "camera", "camera-zoom", "camera-pan", "item-alone-error-recovery", "keyed-pose-ground-truth", "hide-replace", "outfit-composition", "intentional-cutout", "dark-valid", "invalid-model", "stalled-render-cleanup", "linux-container-memory"]) {
      if (!observations.some((observation) => observation.name === name)) {
        observations.push({ name, status: "not-run", detail: "Required before renderer acceptance; not established by this capability probe." });
      }
    }
    const report = {
      status: "incomplete", previewUrl: url, actualRenderer,
      environment: { platform: platform(), arch: arch(), browserVersion, channel: "chromium", gpu, gpuInfo, webgpuAdapter },
      build: localAssets ? {
        previewVersion: build.previewVersion, previewSourceCommit: build.previewSourceCommit,
        origin: "local", directory: resolve(values["renderer-build"]!),
        wrapperAssets: build.assets.filter((asset) => !asset.path.startsWith("unity/")),
        rendererAssets: [...localAssets].map(([path, asset]) => ({ path, source: asset.source, sha256: asset.sha256, bytes: asset.body.length }))
      } : build,
      settings, elapsedMs: Math.round(performance.now() - started), fixtureDigests,
      observations, captures, assets: assets.sort((a, b) => a.url.localeCompare(b.url)), diagnostics
    };
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    const cards = captures.map((capture) => `<figure><img src="${capture.name}.png" width="384"><figcaption>${capture.name} (${capture.width}×${capture.height})</figcaption></figure>`).join("\n");
    await writeFile(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Renderer probe evidence</title><style>body{font:16px system-ui;background:#222;color:#eee}main{display:flex;flex-wrap:wrap}figure{margin:16px}img{max-width:100%}</style><h1>Renderer probe evidence</h1><p>Incomplete feasibility experiment. <a href="report.json">Observations and provenance</a></p><main>${cards}</main>`);
    console.log(`Review ${join(out, "index.html")} and report.json. Renderer acceptance remains incomplete.`);
    process.exitCode = 1;
  }
}

await main();
