import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { BrowserContext, Route, WebSocketRoute } from "playwright-core";
import { manifest } from "../manifest/index.js";
import {
  browserRequestAllowed,
  captureAll, sessionOrder,
  createRenderer,
  previewItem,
  previewUrl,
  PREVIEW_HOST_URL,
  PREVIEW_URL,
  readLocalBuild,
  routeAssets,
  stableScreenshot,
  type PreviewEvent,
  type PreviewSession
} from "./rendering.js";
import type { CaptureRequest, Renderer, RenderInput } from "../types.js";
import { pngBytes } from "#test/helpers/synthetic.js";

const SIZE = 16;
const LENGTH = 2;
const [MALE, FEMALE] = manifest.rendering.bodyShapes;
const { settleMs, stabilityMs, maxStabilityAttempts, profile, wearablePose, wearablePoseFraction } = manifest.rendering;
const AZIMUTHS = manifest.rendering.azimuthDegrees.wearable;

/** Three PNGs whose decoded pixels differ — enough to script settling and camera changes. */
const FRAMES = [pngBytes(SIZE, SIZE), pngBytes(SIZE, SIZE, true), pngBytes(SIZE, SIZE, false, 3)];

const input: RenderInput = {
  files: new Map([["model.glb", new Uint8Array([1, 2, 3])]]),
  item: { category: "hat", representations: [{ bodyShapes: [MALE, FEMALE], mainFile: "model.glb", contents: ["model.glb"] }] },
  itemType: "wearable",
  category: "hat"
};

function request(rendererBuild: string, fields: Partial<CaptureRequest> = {}): CaptureRequest {
  const bodyShape = fields.bodyShape ?? MALE;
  const view = fields.view ?? "avatar";
  const azimuthDegrees = fields.azimuthDegrees ?? 0;
  const id = `${bodyShape.split(":").pop()}-${view}-${String(azimuthDegrees).padStart(3, "0")}`;
  return {
    id, key: id, inputDigest: "input", rendererBuild, recipeVersion: 1, mainFile: "model.glb", size: SIZE,
    bodyShape, view, azimuthDegrees, ...fields
  };
}

/** The V-05 wearable recipe order: bodyShapes × views × azimuths. */
function recipe(rendererBuild: string): CaptureRequest[] {
  return [MALE, FEMALE].flatMap((bodyShape) =>
    (["avatar", "wearable"] as const).flatMap((view) =>
      AZIMUTHS.map((azimuthDegrees) => request(rendererBuild, { bodyShape, view, azimuthDegrees }))
    )
  );
}

function dataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

interface Scripted {
  session: PreviewSession;
  /** Every message that crossed the seam, in order: [name, payload]. */
  log: [string, unknown][];
  closed: number;
  screenshots: number;
}

interface Script {
  engine?: string;
  /** PNG for the n-th screenshot since the last camera move (camera = moves so far). */
  frame?: (camera: number, shot: number) => Uint8Array;
  update?: PreviewSession["update"];
}

/** A PreviewSession object literal: records the wire, answers getLength/getScreenshot, never waits. */
function scripted(script: Script = {}): Scripted {
  const wire: Scripted = { log: [], closed: 0, screenshots: 0, session: undefined! };
  let camera = -1;
  let shot = 0;
  const frame = script.frame ?? ((camera) => FRAMES[camera % FRAMES.length]);
  wire.session = {
    engine: script.engine ?? "unity",
    update: async (item, options) => {
      wire.log.push(["update", options]);
      if (script.update) return script.update(item, options);
      return { type: "load", payload: { renderer: script.engine ?? "unity" } } satisfies PreviewEvent;
    },
    request: async (namespace, method, params) => {
      wire.log.push([`${namespace}.${method}`, params]);
      if (method === "getLength") return LENGTH;
      if (method === "changeCameraPosition") {
        camera++;
        shot = 0;
      }
      if (method === "getScreenshot") {
        wire.screenshots++;
        return dataUrl(frame(Math.max(camera, 0), shot++));
      }
      return null;
    },
    pause: async (ms) => {
      wire.log.push(["pause", ms]);
    },
    close: async () => {
      wire.closed++;
    }
  };
  return wire;
}

async function withBuildDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "renderer-build-"));
  try {
    await writeFile(join(directory, "avatar-preview-renderer.loader.js"), "loader");
    await writeFile(join(directory, "avatar-preview-renderer.framework.js.br"), brotliCompressSync(Buffer.from("framework")));
    await writeFile(join(directory, "avatar-preview-renderer.wasm.gz"), gzipSync(Buffer.from("wasm")));
    await writeFile(join(directory, "avatar-preview-renderer.data"), "data");
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function renderer(directory: string, open: (signal: AbortSignal) => Promise<PreviewSession>): Promise<Renderer> {
  return createRenderer({ buildDirectory: directory, open });
}

describe("readLocalBuild", () => {
  it("decodes Brotli, gzip and uncompressed outputs and rejects two candidates for one binary", async () => {
    await withBuildDir(async (directory) => {
      const assets = await readLocalBuild(directory);
      assert.equal(assets.size, 4);
      assert.equal(assets.get("unity/Build/avatar-preview-renderer.framework.js.br")?.body.toString(), "framework");
      assert.equal(assets.get("unity/Build/avatar-preview-renderer.wasm.br")?.body.toString(), "wasm");
      assert.equal(assets.get("unity/Build/avatar-preview-renderer.wasm.br")?.contentType, "application/wasm");
      assert.equal(assets.get("unity/Build/avatar-preview-renderer.data.br")?.body.toString(), "data");
      assert.equal(assets.get("unity/Build/avatar-preview-renderer.loader.js")?.body.toString(), "loader");

      await writeFile(join(directory, "avatar-preview-renderer.data.br"), brotliCompressSync(Buffer.from("stale data")));
      await assert.rejects(readLocalBuild(directory), /exactly one avatar-preview-renderer.data/);
    });
  });

  it("rejects an incomplete build instead of mixing in deployed binaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "renderer-build-"));
    try {
      await writeFile(join(directory, "avatar-preview-renderer.loader.js"), "loader");
      await assert.rejects(readLocalBuild(directory), /exactly one avatar-preview-renderer.framework.js/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("previewItem", () => {
  it("preserves distinct representations with their hide/replace overrides", () => {
    const item = previewItem({
      files: new Map([["male.glb", Buffer.from("male fixture")], ["female.glb", Buffer.from("female fixture")]]),
      item: {
        hides: ["hands"], replaces: ["lower_body"],
        representations: [
          { bodyShapes: [MALE], mainFile: "male.glb", contents: ["male.glb"], overrideHides: ["head"], overrideReplaces: [] },
          { bodyShapes: [FEMALE], mainFile: "female.glb", contents: ["female.glb"], overrideHides: [], overrideReplaces: ["feet"] }
        ]
      },
      itemType: "wearable",
      category: "upper_body"
    });
    assert.equal(item.data?.category, "upper_body");
    assert.deepEqual(item.data?.hides, ["hands"]);
    assert.deepEqual(item.data?.replaces, ["lower_body"]);
    const representations = item.data!.representations;
    assert.deepEqual(representations.map((rep) => rep.bodyShapes), [[MALE], [FEMALE]]);
    assert.deepEqual(representations.map((rep) => rep.mainFile), ["male.glb", "female.glb"]);
    assert.deepEqual(
      representations.map((rep) => rep.contents.map((content) => Buffer.from(content.base64, "base64").toString())),
      [["male fixture"], ["female fixture"]]
    );
    assert.deepEqual(representations[0].overrideHides, ["head"]);
    assert.deepEqual(representations[1].overrideReplaces, ["feet"]);
    assert.equal(item.emoteDataADR74, undefined);
  });

  it("builds the ADR-74 emote body with the declared loop flag", () => {
    const item = previewItem({ ...input, item: { ...input.item, loop: true }, itemType: "emote", category: "fun" });
    assert.equal(item.data, undefined);
    assert.equal(item.emoteDataADR74?.loop, true);
    assert.equal(item.emoteDataADR74?.category, "fun");
  });

  it("rejects a missing declared file instead of falling back to another GLB", () => {
    const item = { representations: [{ bodyShapes: [MALE], mainFile: "missing.glb", contents: ["missing.glb"] }] };
    assert.throws(() => previewItem({ ...input, item }), /declared preview file "missing.glb"/);
  });
});

describe("previewUrl", () => {
  it("selects Unity in Builder mode with a static camera and the manifest scene", () => {
    const url = new URL(previewUrl());
    assert.ok(url.href.startsWith("https://cdn.decentraland.org/@dcl/wearable-preview/"));
    assert.equal(url.searchParams.get("unity"), "true");
    assert.equal(url.searchParams.get("mode"), "builder");
    assert.equal(url.searchParams.get("camera"), "static");
    assert.equal(url.searchParams.get("profile"), profile);
    assert.equal(url.searchParams.get("background"), manifest.rendering.background);
    assert.equal(url.searchParams.get("skin"), manifest.rendering.skin);
    assert.equal(new URL(previewUrl("babylon")).searchParams.get("unity"), "false");
  });
});

describe("browserRequestAllowed", () => {
  it("allows only https to the host page, the wrapper CDN and Decentraland's own hosts", () => {
    assert.equal(browserRequestAllowed(PREVIEW_HOST_URL), true);
    assert.equal(browserRequestAllowed(`${PREVIEW_URL}index.html`), true);
    assert.equal(browserRequestAllowed("https://peer.decentraland.org/lambdas/profiles/default1"), true);
    assert.equal(browserRequestAllowed("https://decentraland.org/"), true);
    assert.equal(browserRequestAllowed("https://example.com/"), false);
    assert.equal(browserRequestAllowed("https://decentraland.org.evil.com/"), false);
    assert.equal(browserRequestAllowed("https://evildecentraland.org/"), false);
    assert.equal(browserRequestAllowed("http://peer.decentraland.org/"), false);
    assert.equal(browserRequestAllowed("https://10.0.0.1/"), false);
    assert.equal(browserRequestAllowed("https://localhost:8080/"), false);
    assert.equal(browserRequestAllowed("not a url"), false);
  });
});

describe("routeAssets", () => {
  /** A BrowserContext that only records route handlers, and a Route that records its outcome. */
  function fakeContext() {
    const routes: { pattern: unknown; handler: (route: Route) => unknown }[] = [];
    const sockets: ((socket: WebSocketRoute) => unknown)[] = [];
    const context = {
      route: async (pattern: unknown, handler: (route: Route) => unknown) => {
        routes.push({ pattern, handler });
      },
      routeWebSocket: async (_pattern: unknown, handler: (socket: WebSocketRoute) => unknown) => {
        sockets.push(handler);
      }
    } as unknown as BrowserContext;
    const request = async (url: string): Promise<string> => {
      let outcome = "unhandled";
      const route = {
        request: () => ({ url: () => url }),
        continue: async () => {
          outcome = "continue";
        },
        abort: async (code?: string) => {
          outcome = `abort:${code}`;
        },
        fulfill: async () => {
          outcome = "fulfill";
        }
      } as unknown as Route;
      await routes[0].handler(route);
      return outcome;
    };
    return { context, routes, sockets, request };
  }

  it("registers a catch-all first that aborts every host off the allowlist and logs each blocked host once", async () => {
    const fake = fakeContext();
    const logged: [string, Record<string, unknown> | undefined][] = [];
    await routeAssets(fake.context, undefined, (message, fields) => logged.push([message, fields]));
    assert.equal(fake.routes[0].pattern, "**/*");
    assert.ok(fake.routes.length > 1);
    assert.equal(await fake.request("https://peer.decentraland.org/content/contents/bafy"), "continue");
    assert.equal(await fake.request("https://evil.example/collect?x=1"), "abort:blockedbyclient");
    assert.equal(await fake.request("https://evil.example/collect?x=2"), "abort:blockedbyclient");
    assert.equal(await fake.request("http://internal.service.local:9200/"), "abort:blockedbyclient");
    assert.equal(await fake.request("https://t.contentsquare.net/uxa/x.js"), "abort:blockedbyclient", "the wrapper's analytics take the same door, so the URL is never logged");
    assert.deepEqual(logged, [
      ["browser request blocked", { host: "evil.example" }],
      ["browser request blocked", { host: "internal.service.local:9200" }],
      ["browser request blocked", { host: "t.contentsquare.net" }]
    ]);
    assert.ok(fake.routes.every((route) => !(route.pattern instanceof RegExp)), "no host-specific abort route pre-empts the catch-all");
  });

  it("names only the first few blocked hosts, then says there were more", async () => {
    const fake = fakeContext();
    const logged: [string, Record<string, unknown> | undefined][] = [];
    await routeAssets(fake.context, undefined, (message, fields) => logged.push([message, fields]));
    for (let i = 0; i < 3000; i++) assert.equal(await fake.request(`https://host-${i}.attacker.example/x`), "abort:blockedbyclient");
    assert.equal(logged.length, 11);
    assert.equal(logged.filter(([message]) => message === "browser request blocked").length, 10);
    assert.deepEqual(logged.at(-1), ["browser requests blocked from more hosts than are listed", { listed: 10 }]);
  });

  it("closes every WebSocket", async () => {
    const fake = fakeContext();
    const logged: string[] = [];
    await routeAssets(fake.context, undefined, (message) => logged.push(message));
    let closed = false;
    const socket = { url: () => "wss://evil.example/socket", close: async () => { closed = true; } } as unknown as WebSocketRoute;
    await fake.sockets[0](socket);
    assert.equal(closed, true);
    assert.deepEqual(logged, ["browser request blocked"]);
  });
});

describe("stableScreenshot", () => {
  it("returns on the first repeated pixel digest", async () => {
    const wire = scripted({ frame: (_camera, shot) => FRAMES[shot === 0 ? 0 : 1] });
    const shot = await stableScreenshot(wire.session, SIZE);
    assert.equal(wire.screenshots, 3);
    assert.deepEqual(shot.bytes, Buffer.from(FRAMES[1]));
    assert.deepEqual(wire.log.filter(([name]) => name === "pause"), Array(3).fill(["pause", stabilityMs]));
  });

  it("rejects a pose that never settles after maxStabilityAttempts", async () => {
    const wire = scripted({ frame: (_camera, shot) => FRAMES[shot % FRAMES.length] });
    await assert.rejects(stableScreenshot(wire.session, SIZE), /did not settle/);
    assert.equal(wire.screenshots, maxStabilityAttempts);
  });

  it("rejects a non-PNG answer and a wrong size", async () => {
    const text = scripted();
    text.session.request = async () => "data:text/plain;base64,aGk=";
    await assert.rejects(stableScreenshot(text.session, SIZE), /did not return a PNG/);
    const small = scripted({ frame: () => pngBytes(SIZE / 2, SIZE / 2) });
    await assert.rejects(stableScreenshot(small.session, SIZE), /wrong screenshot size/);
  });
});

describe("createRenderer", () => {
  it("digests the local binaries into buildId and refuses requests for another build", async () => {
    await withBuildDir(async (directory) => {
      const first = await renderer(directory, async () => scripted().session);
      assert.match(first.buildId, /^[0-9a-f]{64}$/);
      await writeFile(join(directory, "avatar-preview-renderer.data"), "other data");
      const second = await renderer(directory, async () => scripted().session);
      assert.notEqual(second.buildId, first.buildId);
      await assert.rejects(second.capture(input, [request(first.buildId)]), /different renderer build/);
      assert.deepEqual(await second.capture(input, []), []);
    });
  });

  it("sends exactly the wire sequence for a two-shape wearable", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted();
      const engine = await renderer(directory, async () => wire.session);
      const requests = recipe(engine.buildId);
      const captures = await engine.capture(input, requests);

      const radians = (degrees: number) => (degrees * Math.PI) / 180;
      const setup = (bodyShape: string, type: string) => [
        ["update", { bodyShape, type, profile, emote: wearablePose }],
        ["emote.pause", []], ["emote.getLength", []], ["emote.goTo", [LENGTH * wearablePoseFraction]],
        ["pause", settleMs]
      ];
      const view = (delta: number) => [
        ["scene.changeCameraPosition", [{ alpha: radians(delta), beta: 0, radius: 0 }]],
        ["pause", stabilityMs], ["scene.getScreenshot", [SIZE, SIZE]],
        ["pause", stabilityMs], ["scene.getScreenshot", [SIZE, SIZE]]
      ];
      const views = AZIMUTHS.flatMap((azimuth, index) => view(azimuth - (AZIMUTHS[index - 1] ?? 0)));
      // item-alone views first (both shapes), then worn views — the order that keeps item-alone framing repeatable
      const expected = [
        ...[MALE, FEMALE].flatMap((bodyShape) => [...setup(bodyShape, "wearable"), ...views]),
        ...[MALE, FEMALE].flatMap((bodyShape) => [...setup(bodyShape, "avatar"), ...views])
      ];
      assert.deepEqual(wire.log, expected);

      assert.equal(captures.length, requests.length);
      assert.deepEqual(new Set(captures.map((capture) => capture.request.id)), new Set(requests.map((request) => request.id)));
      assert.ok(captures.every((capture) => capture.width === SIZE && capture.height === SIZE && capture.sha256.length === 64));
      // the session lives as long as the renderer: a run's later views reuse this browser instead of booting another
      assert.equal(wire.closed, 0);
      await engine.stop();
      assert.equal(wire.closed, 1);
    });
  });

  it("seeks each emote frame and skips the wearable pose", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted();
      const engine = await renderer(directory, async () => wire.session);
      const emote: RenderInput = { ...input, itemType: "emote", category: "fun" };
      const fraction = manifest.rendering.emoteFractions[1];
      await engine.capture(emote, [request(engine.buildId, { id: "t", key: "t", timeFraction: fraction })]);
      const [update, pause, length, goTo] = wire.log; // the settle pause now follows the seek
      assert.equal((update[1] as Record<string, unknown>).emote, undefined);
      assert.deepEqual(pause, ["emote.pause", []]);
      assert.deepEqual(length, ["emote.getLength", []]);
      assert.deepEqual(goTo, ["emote.goTo", [LENGTH * fraction]]);
    });
  });

  it("rejects a Babylon load and closes the session once", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted({ engine: "babylon" });
      const engine = await renderer(directory, async () => wire.session);
      await assert.rejects(engine.capture(input, [request(engine.buildId)]), /requires the configured Unity build/);
      assert.equal(wire.closed, 1);
      assert.equal(wire.log.length, 0);
    });
  });

  it("rejects a renderer that ignores the camera change", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted({ frame: () => FRAMES[0] });
      const engine = await renderer(directory, async () => wire.session);
      const [front, side] = AZIMUTHS;
      const requests = [front, side].map((azimuthDegrees) => request(engine.buildId, { azimuthDegrees }));
      await assert.rejects(engine.capture(input, requests), /ignored the camera change/);
      assert.equal(wire.closed, 1);
    });
  });

  it("keeps identical item-alone views — the guard is for the avatar view only", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted({ frame: () => FRAMES[0] });
      const engine = await renderer(directory, async () => wire.session);
      const requests = AZIMUTHS.map((azimuthDegrees) => request(engine.buildId, { view: "wearable", azimuthDegrees }));
      const captures = await engine.capture(input, requests);
      assert.equal(captures.length, AZIMUTHS.length);
    });
  });

  it("closes the session when update throws", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted({
        update: async () => {
          throw new Error("Model failed to load");
        }
      });
      const engine = await renderer(directory, async () => wire.session);
      await assert.rejects(engine.capture(input, [request(engine.buildId)]), /failed to load/);
      assert.equal(wire.closed, 1);
    });
  });

  it("gives each body shape its own browser when the host allows more than one session", async () => {
    await withBuildDir(async (directory) => {
      const wires: Scripted[] = [];
      const engine = await createRenderer({
        buildDirectory: directory,
        maxSessions: 2,
        open: async () => {
          const wire = scripted();
          wires.push(wire);
          return wire.session;
        }
      });
      const requests = recipe(engine.buildId);
      const captures = await engine.capture(input, requests);
      assert.equal(wires.length, 2, "one browser per body shape");
      assert.deepEqual(captures.map((capture) => capture.request.id), requests.map((request) => request.id), "results come back in the order they were asked for");
      const shapesPerWire = wires.map((wire) => new Set(wire.log.filter(([name]) => name === "update").map(([, options]) => (options as { bodyShape?: string }).bodyShape)));
      assert.ok(shapesPerWire.every((shapes) => shapes.size === 1), "a browser only ever loads one body shape");
      assert.equal(new Set(shapesPerWire.flatMap((shapes) => [...shapes])).size, 2, "between them they cover both");
      await engine.stop();
      assert.deepEqual(wires.map((wire) => wire.closed), [1, 1]);
    });
  });

  it("opens one browser for every capture of a run, and shares one promise between identical concurrent requests", async () => {
    await withBuildDir(async (directory) => {
      let opens = 0;
      const engine = await renderer(directory, async () => {
        opens++;
        return scripted().session;
      });
      const requests = [request(engine.buildId)];
      const [first, second] = await Promise.all([engine.capture(input, requests), engine.capture(input, requests)]);
      assert.equal(opens, 1);
      assert.equal(first, second, "identical un-signalled requests share one promise");
      await engine.capture(input, requests);
      assert.equal(opens, 1, "a later capture reuses the same browser");
      await engine.stop();
      await assert.rejects(engine.capture(input, requests), /has stopped/);
    });
  });

  it("stop() aborts the in-flight capture, closes its session and rejects new work", async () => {
    await withBuildDir(async (directory) => {
      let ready: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const wire = scripted();
      const engine = await renderer(directory, async (signal) => {
        wire.session.update = () =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Capture aborted")), { once: true });
            ready();
          });
        return wire.session;
      });
      const operation = engine.capture(input, [request(engine.buildId)]);
      const rejected = assert.rejects(operation, /stopped before the views/);
      await started;
      await engine.stop();
      await rejected;
      assert.equal(wire.closed, 1);
      await assert.rejects(engine.capture(input, [request(engine.buildId)]), /stopped/);
    });
  });

  it("rejects an already-aborted signal before opening a session", async () => {
    await withBuildDir(async (directory) => {
      let opens = 0;
      const engine = await renderer(directory, async () => {
        opens++;
        return scripted().session;
      });
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(engine.capture(input, [request(engine.buildId)], controller.signal), { name: "AbortError" });
      assert.equal(opens, 0);
    });
  });

  it("aborts a running capture from the caller's signal", async () => {
    await withBuildDir(async (directory) => {
      const wire = scripted();
      const engine = await renderer(directory, async () => wire.session);
      const controller = new AbortController();
      wire.session.pause = async () => controller.abort();
      await assert.rejects(engine.capture(input, recipe(engine.buildId), controller.signal), { name: "AbortError" });
      assert.equal(wire.closed, 1);
    });
  });
});

describe("createRenderer timeouts", () => {
  it("lets the host override the manifest's whole-capture timeout", async () => {
    await withBuildDir(async (directory) => {
      // a browser that never comes up but honours the abort the timeout fires
      const never = (signal: AbortSignal) => new Promise<PreviewSession>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      const slow = await createRenderer({ buildDirectory: directory, open: never, timeouts: { timeoutMs: 20 } });
      await assert.rejects(slow.capture(input, recipe(slow.buildId).slice(0, 1)), /did not finish within 20 ms/);
      await slow.stop();
    });
  });
});

describe("captureAll", () => {
  it("issues one update per body shape and view", async () => {
    const wire = scripted();
    const requests = recipe("build");
    await captureAll(wire.session, input, requests, new AbortController().signal);
    const updates = wire.log.filter(([name]) => name === "update");
    assert.equal(updates.length, 4);
  });

  it("poses a wearable with the requested clip and fraction, one update per pose", async () => {
    const wire = scripted();
    const requests = [
      request("build", { bodyShape: MALE, view: "avatar", azimuthDegrees: 0 }),
      request("build", { bodyShape: MALE, view: "avatar", azimuthDegrees: 0, pose: "run", timeFraction: 0.5 }),
      request("build", { bodyShape: MALE, view: "avatar", azimuthDegrees: 90, pose: "run", timeFraction: 0.5 })
    ];
    await captureAll(wire.session, input, requests, new AbortController().signal);
    const updates = wire.log.filter(([name]) => name === "update").map(([, options]) => (options as { emote?: string }).emote);
    assert.deepEqual(updates, [manifest.rendering.wearablePose, "run"]);
    const seeks = wire.log.filter(([name]) => name === "emote.goTo").map(([, params]) => (params as number[])[0]);
    assert.deepEqual(seeks, [0, 0.5 * LENGTH]);
  });

  it("retries a view whose previewer command timed out, from a fresh update, and gives up after the manifest's retries", async () => {
    const flaky = scripted();
    const inner = flaky.session.request;
    let failures = 1;
    flaky.session.request = async (namespace, method, params) => {
      if (method === "pause" && failures-- > 0) throw Object.assign(new Error("page.waitForFunction: Timeout 15000ms exceeded."), { name: "TimeoutError" });
      return inner(namespace, method, params);
    };
    const requests = recipe("build");
    const captures = await captureAll(flaky.session, input, requests, new AbortController().signal);
    assert.equal(captures.length, requests.length);
    assert.equal(flaky.log.filter(([name]) => name === "update").length, 5);

    const stuck = scripted();
    stuck.session.request = async (_namespace, method) => {
      if (method === "pause") throw Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
      return null;
    };
    await assert.rejects(captureAll(stuck.session, input, requests, new AbortController().signal), /Timeout/);
    assert.equal(stuck.log.filter(([name]) => name === "update").length, 1 + manifest.rendering.captureRetries);

    const broken = scripted();
    broken.session.request = async () => {
      throw new Error("The previewer rejected scene.changeCameraPosition.");
    };
    await assert.rejects(captureAll(broken.session, input, requests, new AbortController().signal), /rejected/);
    assert.equal(broken.log.filter(([name]) => name === "update").length, 1);
  });

  it("hands each capture to onCapture the moment it lands, in request order", async () => {
    const wire = scripted();
    const requests = recipe("build");
    const seen: string[] = [];
    const captures = await captureAll(wire.session, input, requests, new AbortController().signal, (capture) => seen.push(capture.request.id));
    assert.deepEqual(seen, sessionOrder(requests).map((request) => request.id));
    assert.equal(captures.length, seen.length);
  });
});
