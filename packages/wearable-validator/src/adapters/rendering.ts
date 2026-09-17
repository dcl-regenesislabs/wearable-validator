/**
 * The /rendering entry: Chromium, the pinned wearable-preview wrapper and local Unity binaries
 * behind the Renderer contract — node-only (playwright-core peer).
 * Previous hop: captures.resolveCaptures() asks Renderer.capture() for the views a rule is missing.
 * Next hop: the CaptureRecords land in ctx.captures / Result.captures; tools/src/renderer-probe.ts
 * drives the same page-level exports for observation runs.
 * Reads top to bottom: local build → item → wire protocol → browser and session → screenshots → capture loop → renderer.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { decode } from "fast-png";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import playwright from "playwright-core/package.json" with { type: "json" };
import { digest, digestJson } from "../logic/captures.js";
import { imageDimensions } from "../logic/images.js";
import { manifest, type Manifest } from "../manifest/index.js";
import build from "./rendering-build.json" with { type: "json" };
import type { CaptureRecord, CaptureRequest, Renderer, RenderInput } from "../types.js";

/** The only place the wrapper version is read — rendering-build.json pins it with its asset hashes. */
export const PREVIEW_URL = `https://cdn.decentraland.org/@dcl/wearable-preview/${build.previewVersion}/`;
/** Fulfilled from memory with the page that holds the iframe — never fetched. */
export const PREVIEW_HOST_URL = "https://preview-host.invalid/";
/** Beyond the host page and the wrapper CDN, the wrapper only needs Decentraland's own services (profiles, base-avatar content). */
const BROWSER_ALLOWED_DOMAIN = "decentraland.org";
const BROWSER_ALLOWED_HOSTS = new Set([new URL(PREVIEW_HOST_URL).hostname, new URL(PREVIEW_URL).hostname]);

/** Whether Chromium may send this request: https to an allowlisted host — creator content loaded in the page reaches nothing else. */
export function browserRequestAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return BROWSER_ALLOWED_HOSTS.has(host) || host === BROWSER_ALLOWED_DOMAIN || host.endsWith(`.${BROWSER_ALLOWED_DOMAIN}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.slice(0, 253);
  } catch {
    return "(unparsable)";
  }
}

export type Gpu = "hardware" | "software";

// ---- local Unity build ------------------------------------------------------------------------

export interface LocalAsset {
  body: Buffer;
  sha256: string;
  source: string;
  contentType: string;
}

export type LocalBuild = Map<string, LocalAsset>;

// exactly one of each avatar-preview-renderer.{loader.js,framework.js,wasm,data}[.br|.gz], decoded on read; symbols optional; an incomplete build never mixes with deployed binaries
export async function readLocalBuild(directory: string): Promise<LocalBuild> {
  const root = resolve(directory);
  const files = await readdir(root);
  const assets: LocalBuild = new Map();
  for (const [extension, contentType] of [
    ["loader.js", "application/javascript"],
    ["framework.js", "application/javascript"],
    ["wasm", "application/wasm"],
    ["data", "application/octet-stream"],
    ["symbols.json", "application/json"]
  ]) {
    const name = `avatar-preview-renderer.${extension}`;
    const candidates = [name, `${name}.br`, `${name}.gz`].filter((candidate) => files.includes(candidate));
    if (candidates.length === 0 && extension === "symbols.json") continue;
    if (candidates.length !== 1)
      throw new Error(`Provide exactly one ${name} build file (uncompressed, .br or .gz) in ${root}.`);
    const source = join(root, candidates[0]);
    const encoded = await readFile(source);
    const body = source.endsWith(".br")
      ? brotliDecompressSync(encoded)
      : source.endsWith(".gz")
        ? gunzipSync(encoded)
        : encoded;
    const requestPath = `unity/Build/${name}${extension === "loader.js" ? "" : ".br"}`;
    assets.set(requestPath, { body, contentType, source, sha256: createHash("sha256").update(body).digest("hex") });
  }
  return assets;
}

// ---- the item the wrapper receives ------------------------------------------------------------

export interface PreviewRepresentation {
  bodyShapes: string[];
  mainFile: string;
  contents: { key: string; base64: string }[];
  overrideHides: string[];
  overrideReplaces: string[];
}

export interface PreviewItem {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
  image: string;
  rarity: string;
  i18n: { code: string; text: string }[];
  data?: {
    category: string;
    hides: string[];
    replaces: string[];
    tags: string[];
    representations: PreviewRepresentation[];
  };
  emoteDataADR74?: { category: string; loop: boolean; tags: string[]; representations: PreviewRepresentation[] };
}

export function previewItem(input: RenderInput): PreviewItem {
  // representations stay as declared — never the debug-ui shortcut that copies the first one to both shapes
  const representations = input.item.representations!.map((rep) => ({
    ...rep,
    contents: rep.contents.map((key) => {
      const bytes = input.files.get(key);
      if (!bytes) throw new Error(`Add the declared preview file "${key}".`);
      return { key, base64: Buffer.from(bytes).toString("base64") };
    }),
    overrideHides: rep.overrideHides ?? [],
    overrideReplaces: rep.overrideReplaces ?? []
  }));
  const item: PreviewItem = {
    id: "urn:decentraland:off-chain:preview:visual-review",
    name: "Visual review",
    description: "",
    thumbnail: "",
    image: "",
    rarity: "common",
    i18n: [{ code: "en", text: "Visual review" }]
  };
  if (input.itemType === "wearable") {
    item.data = {
      category: input.category,
      hides: input.item.hides ?? [],
      replaces: input.item.replaces ?? [],
      tags: [],
      representations
    };
  } else {
    item.emoteDataADR74 = { category: input.category, loop: input.item.loop ?? false, tags: [], representations };
  }
  return item;
}

// ---- wire protocol (page-bound) ----------------------------------------------------------------

export interface PreviewEvent {
  type: string;
  payload?: { id?: string; ok?: boolean; result?: unknown; error?: string; message?: string; renderer?: string };
}

export class PreviewLoadError extends Error {}

/** The host page buffers wrapper messages here; typed locally so consumers' Window stays untouched. */
type PreviewWindow = Window & { previewEvents: PreviewEvent[] };

/** The seam createRenderer works through: the wrapper's postMessage protocol, not Playwright's Page. */
export interface PreviewSession {
  /** The engine the first load event reported ("unity" | "babylon" | "unknown"). */
  engine: string;
  update(item: PreviewItem | undefined, options: Record<string, unknown>): Promise<PreviewEvent>;
  request(namespace: "scene" | "emote", method: string, params: unknown[]): Promise<unknown>;
  pause(ms: number): Promise<void>;
  close(): Promise<void>;
}

export type OpenPreview = (signal: AbortSignal) => Promise<PreviewSession>;

/** Diagnostics the host may log: what the browser did, in words an operator can act on. Never pixels, never bytes. */
export type RenderLog = (message: string, fields?: Record<string, unknown>) => void;

/** The last few wrapper messages, shortened: what the previewer said before it went quiet. */
async function recentPreviewEvents(page: Page, count = 6): Promise<unknown[]> {
  try {
    return await page.evaluate(
      (count) => (window as unknown as PreviewWindow).previewEvents.slice(-count).map((event) => ({ type: event.type, ...(event.payload?.message ? { message: String(event.payload.message).slice(0, 200) } : {}), ...(event.payload?.error ? { error: String(event.payload.error).slice(0, 200) } : {}) })),
      count
    );
  } catch {
    return [];
  }
}

// Unity repeats the same warning every frame: each distinct line is logged once per page, and only so many
const MAX_PAGE_LINES = 20;
const MAX_BLOCKED_HOSTS_LOGGED = 10;

/** Page-level trouble an operator needs to see: crashes, uncaught errors, console errors, failed requests. */
function watchPage(page: Page, log: RenderLog): void {
  const seen = new Set<string>();
  const once = (message: string, fields: Record<string, unknown>) => {
    const key = message + JSON.stringify(fields);
    if (seen.has(key) || seen.size >= MAX_PAGE_LINES) return;
    seen.add(key);
    log(message, fields);
  };
  page.on("crash", () => log("browser page crashed"));
  page.on("pageerror", (error) => once("browser page error", { error: error.message.slice(0, 300) }));
  page.on("console", (message) => {
    if (message.type() === "error") once("browser console error", { text: message.text().slice(0, 300) });
  });
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText;
    if (error?.includes("BLOCKED_BY_CLIENT")) return; // routeAssets already logged the blocked host, without the URL
    once("browser request failed", { url: request.url().slice(0, 200), error });
  });
}

export function previewUrl(engine: "unity" | "babylon" = "unity"): string {
  const { profile, background, skin } = manifest.rendering;
  const url = new URL("index.html", PREVIEW_URL);
  // unity=true mode=builder profile type=avatar camera=static disableAutoRotate disableFadeEffect background skin — the wrapper logs "Unknown parameter in URL" for several of these; the load event still reports unity, so the warnings are noise
  // mode=builder or the blob item is silently ignored (profile mode loads a stock avatar)
  url.search = new URLSearchParams({
    unity: String(engine === "unity"),
    mode: "builder",
    profile,
    type: "avatar",
    camera: "static",
    disableAutoRotate: "true",
    disableFadeEffect: "true",
    background,
    skin
  }).toString();
  return url.toString();
}

export async function mountPreview(page: Page, url: string, size: number): Promise<void> {
  await page.goto(PREVIEW_HOST_URL);
  // only messages from the iframe window and the wrapper origin count; emote_event is chatter; buffered on the window so waitForFunction can poll
  await page.evaluate(
    ({ url, size }) => {
      const host = window as unknown as PreviewWindow;
      host.previewEvents = [];
      const iframe = document.createElement("iframe");
      iframe.style.cssText = `width:${size}px;height:${size}px;border:0;display:block`;
      window.addEventListener("message", (event) => {
        if (event.source !== iframe.contentWindow || event.origin !== new URL(url).origin) return;
        if (typeof event.data?.type !== "string" || event.data.type === "emote_event") return;
        host.previewEvents.push(event.data);
      });
      iframe.src = url;
      document.body.style.margin = "0";
      document.body.append(iframe);
    },
    { url, size }
  );
}

export async function updatePreview(
  page: Page,
  item: PreviewItem | undefined,
  options: Record<string, unknown>,
  timeout: number
): Promise<PreviewEvent> {
  const start = await page.evaluate(() => (window as unknown as PreviewWindow).previewEvents.length);
  // Blobs cannot cross page.evaluate: bytes travel as base64 and become Blob in-page
  await page.evaluate(
    ({ item, options }) => {
      let blob;
      if (item) {
        const body = item.data ?? item.emoteDataADR74!;
        const representations = body.representations.map((representation) => ({
          ...representation,
          contents: representation.contents.map(({ key, base64 }) => ({
            key,
            blob: new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))])
          }))
        }));
        blob = item.data
          ? { ...item, data: { ...item.data, representations } }
          : { ...item, emoteDataADR74: { ...item.emoteDataADR74, representations } };
      }
      const iframe = document.querySelector("iframe")!;
      iframe.contentWindow!.postMessage(
        { type: "update", payload: { options: { ...options, ...(blob ? { blob } : {}) } } },
        new URL(iframe.src).origin
      );
    },
    { item, options }
  );
  // every update yields a new load or error — wait for it (loadTimeoutMs) before touching the scene
  return waitForLoad(page, start, timeout);
}

export async function waitForLoad(page: Page, start: number, timeout: number): Promise<PreviewEvent> {
  const handle = await page.waitForFunction(
    (start) => (window as unknown as PreviewWindow).previewEvents.slice(start).find((event) => event.type === "load" || event.type === "error"),
    start,
    { timeout }
  );
  const event = (await handle.jsonValue()) as PreviewEvent;
  await handle.dispose();
  // after an error load the pinned wrapper keeps its overlay (wrapper bug) — a session never continues after a load error; the browser closes
  if (event.type === "error")
    throw new PreviewLoadError(event.payload?.message ?? "The previewer reported a load error.");
  return event;
}

export async function requestPreview(
  page: Page,
  namespace: "scene" | "emote",
  method: string,
  params: unknown[],
  timeout: number
): Promise<unknown> {
  const id = crypto.randomUUID();
  await page.evaluate(
    ({ id, namespace, method, params }) => {
      const iframe = document.querySelector("iframe")!;
      iframe.contentWindow!.postMessage(
        { type: "controller_request", payload: { id, namespace, method, params } },
        new URL(iframe.src).origin
      );
    },
    { id, namespace, method, params }
  );
  const handle = await page.waitForFunction(
    (id) => (window as unknown as PreviewWindow).previewEvents.find((event) => event.type === "controller_response" && event.payload?.id === id),
    id,
    { timeout }
  );
  const response = (await handle.jsonValue()) as PreviewEvent;
  await handle.dispose();
  if (!response.payload?.ok)
    throw new Error(response.payload?.error ?? `The previewer rejected ${namespace}.${method}.`);
  return response.payload.result;
}

export type SessionSettings = Pick<Manifest["rendering"], "navigationTimeoutMs" | "loadTimeoutMs" | "commandTimeoutMs">;

/** Binds the protocol to one page; engine stays "unknown" until the caller reads the first load event. */
export function pageSession(page: Page, settings: SessionSettings): PreviewSession {
  page.setDefaultTimeout(settings.commandTimeoutMs);
  page.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
  return {
    engine: "unknown",
    update: (item, options) => updatePreview(page, item, options, settings.loadTimeoutMs),
    request: (namespace, method, params) => requestPreview(page, namespace, method, params, settings.commandTimeoutMs),
    pause: (ms) => page.waitForTimeout(ms),
    close: async () => {
      await page.context().browser()?.close();
    }
  };
}

// ---- browser ---------------------------------------------------------------------------------

// flags request a backend; the probe proves it with navigator.gpu.requestAdapter() inside the frame (architecture swiftshader, isFallbackAdapter)
export const GPU_ARGS: Record<Gpu, string[]> = {
  software: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"],
  hardware: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
};

export function launchChromium(options: { gpu: Gpu; headed?: boolean; executablePath?: string }): Promise<Browser> {
  // channel "chromium" full headless: the headless shell gives WebGPU errors and screenshot timeouts (install with --no-shell)
  // CHROMIUM_ARGS is an operator knob for platform-specific flags (Linux containers need Vulkan-backed SwiftShader); it never changes the pixels' provenance, which is why it is not part of buildId
  const extra = (process.env.CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean);
  return chromium.launch({
    channel: "chromium",
    headless: !options.headed,
    executablePath: options.executablePath,
    args: [...GPU_ARGS[options.gpu], ...extra]
  });
}

/** Without `assets` the deployed binaries are served (the probe's baseline) — still pinned by hash. */
export async function routeAssets(context: BrowserContext, assets?: LocalBuild, log: RenderLog = () => {}): Promise<{ assertHealthy(): void }> {
  let error: string | undefined;
  // registered first so every later route is consulted before it: whatever no other route handles is aborted unless the host is allowlisted
  const blocked = new Set<string>();
  const block = (url: string) => {
    const host = hostOf(url);
    if (blocked.has(host) || blocked.size > MAX_BLOCKED_HOSTS_LOGGED) return;
    blocked.add(host);
    // content can ask for any number of hostnames: the operator log names the first few and then says only that there were more
    if (blocked.size > MAX_BLOCKED_HOSTS_LOGGED) log("browser requests blocked from more hosts than are listed", { listed: MAX_BLOCKED_HOSTS_LOGGED });
    else log("browser request blocked", { host });
  };
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (browserRequestAllowed(url)) return route.continue();
    block(url);
    return route.abort("blockedbyclient");
  });
  // context.route never sees WebSockets; the wrapper opens none, so every socket is closed unanswered
  await context.routeWebSocket("**/*", (socket) => {
    block(socket.url());
    socket.close({ code: 1008, reason: "blocked" });
  });
  // the host page is fulfilled with minimal HTML that holds the iframe; the wrapper's analytics hosts fall to the catch-all above
  await context.route(PREVIEW_HOST_URL, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Visual evidence</title>"
    })
  );
  await context.route(`${PREVIEW_URL}**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(new URL(PREVIEW_URL).pathname.length);
    // deployed 2.20.0 ignores camera changes and draws the avatar in item-only view; only unity/Build/* is served locally, the JS wrapper stays pinned
    if (assets && path.startsWith("unity/Build/")) {
      const asset = assets.get(path);
      if (asset) return route.fulfill({ body: asset.body, contentType: asset.contentType });
      if (!path.endsWith(".symbols.json.br")) error = `The local renderer is missing ${path}.`;
      return route.fulfill({ status: 404, body: "Missing local Unity asset" });
    }
    // allowlist, not passthrough: an asset the lock does not know fails the capture instead of loading silently
    const pin = build.assets.find((asset) => asset.path === path);
    if (!pin) {
      error = `The preview wrapper requested an unpinned asset: ${path}. Add it to rendering-build.json after verifying it.`;
      return route.abort();
    }
    try {
      const response = await route.fetch({ timeout: manifest.rendering.navigationTimeoutMs });
      try {
        // sha256 of decoded bytes vs rendering-build.json — a mismatch is not fixed by bumping the hash
        if (!response.ok() || (await digest(await response.body())) !== pin.sha256) {
          throw new Error(`The pinned preview wrapper changed: ${path}`);
        }
        await route.fulfill({ response });
      } finally {
        await response.dispose();
      }
    } catch {
      error = `Cannot verify the pinned preview wrapper: ${path}`;
      await route.abort();
    }
  });
  return {
    assertHealthy() {
      if (error) throw new Error(error);
    }
  };
}

/** The default seam: one Chromium per session, closed on abort, on failure to load, and by close(). */
export function openPreview(options: { assets?: LocalBuild; gpu: Gpu; headed?: boolean; log?: RenderLog; settings?: RenderTimeouts }): OpenPreview {
  const settings = { ...manifest.rendering, ...options.settings };
  const log: RenderLog = options.log ?? (() => {});
  return async (signal) => {
    signal.throwIfAborted();
    const started = Date.now();
    const browser = await launchChromium(options);
    log("browser launched", { version: browser.version(), gpu: options.gpu, extraArgs: process.env.CHROMIUM_ARGS ?? "", ms: Date.now() - started });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= browser.close());
    const abort = () => {
      void close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const context = await browser.newContext({
        viewport: { width: settings.imageSizePx, height: settings.imageSizePx },
        serviceWorkers: "block"
      });
      const health = await routeAssets(context, options.assets, log);
      const page = await context.newPage();
      watchPage(page, log);
      const session = pageSession(page, settings);
      await mountPreview(page, previewUrl(), settings.imageSizePx);
      log("previewer mounted", { url: previewUrl().slice(0, 120), localBuild: Boolean(options.assets), ms: Date.now() - started });
      let loaded: PreviewEvent;
      try {
        loaded = await waitForLoad(page, 0, settings.loadTimeoutMs);
      } catch (error) {
        log("previewer did not load", { error: error instanceof Error ? error.message.slice(0, 200) : String(error), ms: Date.now() - started, lastEvents: await recentPreviewEvents(page) });
        throw error;
      }
      health.assertHealthy();
      session.engine = loaded.payload?.renderer ?? "unknown";
      log("previewer loaded", { engine: session.engine, ms: Date.now() - started });
      return {
        ...session,
        async close() {
          signal.removeEventListener("abort", abort);
          await close();
        }
      };
    } catch (error) {
      signal.removeEventListener("abort", abort);
      await close();
      throw error;
    }
  };
}

// ---- screenshots -----------------------------------------------------------------------------

export interface Screenshot {
  bytes: Uint8Array;
  /** sha256 of the decoded raw pixels — the stability and camera guards compare these. */
  pixels: string;
}

export async function screenshot(session: PreviewSession, size = manifest.rendering.imageSizePx): Promise<Screenshot> {
  const data = await session.request("scene", "getScreenshot", [size, size]);
  if (typeof data !== "string" || !data.startsWith("data:image/png;base64,")) {
    throw new Error("The preview did not return a PNG screenshot.");
  }
  const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
  // the header is checked before decoding so a wrong-sized answer never inflates
  const header = imageDimensions(bytes);
  if (!header || header.width !== size || header.height !== size) {
    throw new Error("The preview returned the wrong screenshot size.");
  }
  const png = decode(bytes);
  if (png.width !== size || png.height !== size) {
    throw new Error("The preview returned the wrong screenshot size.");
  }
  // two consecutive identical raw-pixel digests = settled; PNG bytes are never compared
  const pixels = await digest(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength));
  return { bytes, pixels };
}

export async function stableScreenshot(session: PreviewSession, size = manifest.rendering.imageSizePx): Promise<Screenshot> {
  const { stabilityMs, maxStabilityAttempts } = manifest.rendering;
  let previous: string | undefined;
  for (let attempt = 0; attempt < maxStabilityAttempts; attempt++) {
    await session.pause(stabilityMs);
    const shot = await screenshot(session, size);
    if (previous === shot.pixels) return shot;
    previous = shot.pixels;
  }
  throw new Error("The preview pose did not settle. Pause animation and retry the capture.");
}

// ---- capture loop ----------------------------------------------------------------------------

async function seekEmote(session: PreviewSession, fraction: number): Promise<void> {
  const duration = await session.request("emote", "getLength", []);
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("The emote did not report a valid duration.");
  }
  await session.request("emote", "goTo", [duration * fraction]);
}

/**
 * Item-alone views before worn views, body shapes in manifest order, request order otherwise.
 * The previewer fits its camera to the item when an item-alone view loads after a worn view of the same shape,
 * and that fit depends on session history; loaded first, the framing is identical across sessions and machines.
 */
export function sessionOrder(requests: CaptureRequest[]): CaptureRequest[] {
  const shapes = manifest.rendering.bodyShapes;
  return requests
    .map((request, index) => ({ request, index }))
    .sort((a, b) =>
      (a.request.view === "wearable" ? 0 : 1) - (b.request.view === "wearable" ? 0 : 1) ||
      shapes.indexOf(a.request.bodyShape) - shapes.indexOf(b.request.bodyShape) ||
      a.index - b.index
    )
    .map(({ request }) => request);
}

/** A previewer command that ran out of time (cold SwiftShader still compiling shaders) is retried from a fresh update. */
function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(error.message));
}

/** One update serves every azimuth of a view; see sessionOrder for why item-alone views go first. */
export async function captureAll(
  session: PreviewSession,
  input: RenderInput,
  requests: CaptureRequest[],
  signal: AbortSignal,
  onCapture?: (capture: CaptureRecord) => void,
  log: RenderLog = () => {}
): Promise<CaptureRecord[]> {
  const settings = manifest.rendering;
  const item = previewItem(input);
  const captures: CaptureRecord[] = [];
  let setup = "";
  let azimuth = 0;
  let front: string | undefined;
  let seeked: number | undefined;

  async function captureOne(request: CaptureRequest): Promise<CaptureRecord> {
    const pose = input.itemType === "wearable" ? request.pose ?? settings.wearablePose : undefined;
    const nextSetup = `${request.bodyShape}:${request.view}:${pose ?? ""}`;
    if (nextSetup !== setup) {
      await session.update(item, { bodyShape: request.bodyShape, type: request.view, profile: settings.profile, emote: pose });
      // idle ignores emote.pause: wearables play a clip (rest pose by default), pause, seek, then settle
      await session.request("emote", "pause", []);
      setup = nextSetup;
      azimuth = 0;
      front = undefined;
      seeked = undefined;
    }
    // seek only when the fraction changes: wearables default to the manifest rest fraction, emotes to what the request says
    const fraction = input.itemType === "wearable" ? request.timeFraction ?? settings.wearablePoseFraction : request.timeFraction;
    if (fraction !== undefined && fraction !== seeked) {
      await seekEmote(session, fraction);
      seeked = fraction;
      await session.pause(settings.settleMs);
    }
    // changeCameraPosition is RELATIVE radians: track the azimuth and send the delta (beta 0, radius 0)
    const alpha = ((request.azimuthDegrees - azimuth) * Math.PI) / 180;
    await session.request("scene", "changeCameraPosition", [{ alpha, beta: 0, radius: 0 }]);
    azimuth = request.azimuthDegrees;
    const { bytes, pixels } = await stableScreenshot(session, request.size);
    if (request.view === "avatar") {
      // avatar view: azimuth 0 and the next azimuth must differ — identical pixels mean the camera receivers are missing (use a build with unity-explorer PR #10053)
      if (request.azimuthDegrees === 0) front = pixels;
      else if (front !== undefined) {
        if (front === pixels) throw new Error("The renderer ignored the camera change — use a build with unity-explorer PR #10053.");
        front = undefined;
      }
    }
    return { request, bytes, sha256: await digest(bytes), width: request.size, height: request.size };
  }

  for (const request of sessionOrder(requests)) {
    let attempts = 0;
    for (;;) {
      signal.throwIfAborted();
      try {
        const capture = await captureOne(request);
        captures.push(capture);
        onCapture?.(capture);
        break;
      } catch (error) {
        if (!timedOut(error) || attempts++ >= settings.captureRetries) throw error;
        // the session state after a timeout is unknown: the next attempt starts from a fresh update
        log("view timed out, retrying from a fresh update", { view: request.id, attempt: attempts, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        setup = "";
      }
    }
  }
  return captures;
}

// ---- the renderer ----------------------------------------------------------------------------

export interface RendererOptions {
  /** Unity Web build carrying the camera and item-only fixes from unity-explorer PR #10053 (unity/Build/* only). */
  buildDirectory: string;
  /** Default "software" (SwiftShader) — the deterministic choice; part of buildId either way. */
  gpu?: Gpu;
  headed?: boolean;
  /** Test seam, defaults to Chromium. */
  open?: OpenPreview;
  /** Called the moment each view is captured — a live UI can show it while the rest render. */
  onCapture?: (capture: CaptureRecord) => void;
  /** Browser diagnostics for the host's log: launch, previewer load or failure, page errors, retries. */
  onLog?: RenderLog;
  /** Operational overrides of the manifest timeouts: a slow host needs longer than a developer's machine. */
  timeouts?: Partial<RenderTimeouts>;
}

export type RenderTimeouts = Pick<Manifest["rendering"], "navigationTimeoutMs" | "loadTimeoutMs" | "commandTimeoutMs" | "timeoutMs">;

export async function createRenderer(options: RendererOptions): Promise<Renderer> {
  const assets = await readLocalBuild(options.buildDirectory);
  const browserOptions = { gpu: options.gpu ?? "software", headed: options.headed };
  // buildId = wrapper lock + playwright version + platform + arch + gpu/headed + local binary sha256s
  const buildId = await digestJson({
    wrapper: build,
    playwright: playwright.version,
    platform: process.platform,
    architecture: process.arch,
    browserOptions,
    binaries: [...assets].map(([path, asset]) => [path, asset.sha256])
  });
  const timeouts: RenderTimeouts = { ...manifest.rendering, ...options.timeouts };
  const open = options.open ?? openPreview({ assets, ...browserOptions, log: options.onLog, settings: timeouts });
  const active = new Map<AbortController, Promise<CaptureRecord[]>>();
  const pending = new Map<string, Promise<CaptureRecord[]>>();
  let stopped = false;

  // one browser per capture() — open → capture → close in finally; identical un-signalled requests share one promise; stop() aborts and rejects further work
  async function capture(input: RenderInput, requests: CaptureRequest[], signal?: AbortSignal): Promise<CaptureRecord[]> {
    signal?.throwIfAborted();
    if (stopped) throw new Error("The renderer has stopped. Create a new renderer to capture views.");
    if (!requests.length) return [];
    if (requests.some((request) => request.rendererBuild !== buildId)) {
      throw new Error("Capture requests target a different renderer build.");
    }
    const key = requests.map((request) => request.key).join(":");
    if (!signal && pending.has(key)) return pending.get(key)!;

    const controller = new AbortController();
    const operation = runCapture(input, requests, controller, signal);
    active.set(controller, operation);
    if (!signal) pending.set(key, operation);
    try {
      return await operation;
    } finally {
      active.delete(controller);
      if (!signal) pending.delete(key);
    }
  }

  async function runCapture(
    input: RenderInput,
    requests: CaptureRequest[],
    controller: AbortController,
    signal?: AbortSignal
  ): Promise<CaptureRecord[]> {
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeouts.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    let session: PreviewSession | undefined;
    try {
      session = await open(controller.signal);
      controller.signal.throwIfAborted();
      // the site URL selects Babylon and a WebGPU fallback is not Unity evidence — a non-unity load closes the browser
      if (session.engine !== "unity") {
        throw new Error(`The preview loaded the ${session.engine} engine. Visual evidence requires the configured Unity build.`);
      }
      return await captureAll(session, input, requests, controller.signal, options.onCapture, options.onLog);
    } catch (error) {
      if (signal?.aborted) throw error; // the caller cancelled: let its AbortError through untouched
      if (controller.signal.aborted) {
        throw new Error(stopped
          ? "Rendering was stopped before the views were captured. Run the capture again."
          : `Rendering did not finish within ${timeouts.timeoutMs} ms. Retry the capture, or raise the render timeout.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await session?.close();
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    for (const controller of active.keys()) controller.abort();
    await Promise.allSettled(active.values());
  }

  return { buildId, capture, stop };
}
