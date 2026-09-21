import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { appLogger } from "../src/adapters/log-buffer.js";
import { resolveProfileDirectory } from "../src/adapters/renderer.js";
import { RENDER_DEPENDENCIES, runSelfTest } from "../src/adapters/self-test.js";
import { startTestServer } from "./components.js";

const recorder = () => {
  const lines: { level: string; message: string; extra: Record<string, unknown> }[] = [];
  const logger = {
    log: () => {},
    debug: () => {},
    info: (message: string, extra: Record<string, unknown> = {}) => lines.push({ level: "INFO", message, extra }),
    warn: (message: string, extra: Record<string, unknown> = {}) => lines.push({ level: "WARN", message, extra }),
    error: (message: string | Error, extra: Record<string, unknown> = {}) => lines.push({ level: "ERROR", message: String(message), extra })
  };
  return { lines, logs: { getLogger: () => logger } };
};

describe("startup self-test", () => {
  it("names the hosts a render needs", () => {
    assert.ok(RENDER_DEPENDENCIES.some((url) => url.startsWith("https://cdn.decentraland.org/")), "the pinned wrapper");
    assert.ok(RENDER_DEPENDENCIES.some((url) => url.startsWith("https://peer.decentraland.org/")), "the content servers the avatar comes from");
  });

  it("passes when the browser draws and every dependency answers", async () => {
    const server = await startTestServer();
    const log = recorder();
    try {
      const result = await runSelfTest(log, {
        dependencies: [`${server.base}/api/health`],
        probe: async () => ({ browserVersion: "153", device: true, adapter: { vendor: "google", architecture: "swiftshader", device: "", description: "", isFallbackAdapter: true }, ms: 10 })
      });
      assert.equal(result.ok, true);
      assert.equal(result.reachability[0].status, 200);
      assert.ok(log.lines.some((line) => line.level === "INFO" && line.message.includes("self-test passed")));
      assert.ok(!log.lines.some((line) => line.level === "ERROR"));
    } finally {
      await server.stop();
    }
  });

  it("says which side failed: a blocked dependency and a browser that cannot draw are different lines", async () => {
    const log = recorder();
    const result = await runSelfTest(log, {
      timeoutMs: 2000,
      dependencies: ["http://127.0.0.1:1/blocked"],
      probe: async () => ({ browserVersion: "153", device: false, error: "WebGPU returned no adapter: the container has no working backend", ms: 20 })
    });
    assert.equal(result.ok, false);
    assert.equal(result.reachability[0].status, null);
    const errors = log.lines.filter((line) => line.level === "ERROR").map((line) => line.message);
    assert.ok(errors.some((message) => message.includes("dependency unreachable")), "the network side");
    assert.ok(errors.some((message) => message.includes("no WebGPU device")), "the browser side");
  });
});

describe("the browser profile", () => {
  it("clears the singleton files a killed container left behind, so Chromium accepts the profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "profile-"));
    const lines: { level: string; message: string }[] = [];
    const logs = {
      getLogger: () => ({
        log: () => {},
        debug: () => {},
        info: (message: string) => lines.push({ level: "INFO", message }),
        warn: (message: string) => lines.push({ level: "WARN", message }),
        error: (message: string | Error) => lines.push({ level: "ERROR", message: String(message) })
      })
    };
    try {
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) await writeFile(join(directory, name), "stale");
      const config = createConfigComponent({ CHROMIUM_PROFILE_DIR: directory, MAX_CONCURRENT_RUNS: "1" });
      const resolved = await resolveProfileDirectory(config, appLogger(logs, "renderer"));
      assert.equal(resolved, directory);
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        await assert.rejects(stat(join(directory, name)), "the stale lock is gone");
      }
      assert.ok(lines.some((line) => line.message.includes("profile kept between runs")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips the profile when more than one run renders at a time, because Chromium locks it", async () => {
    const config = createConfigComponent({ MAX_CONCURRENT_RUNS: "2" });
    const lines: string[] = [];
    const logs = { getLogger: () => ({ log: () => {}, debug: () => {}, info: () => {}, warn: (message: string) => lines.push(message), error: () => {} }) };
    assert.equal(await resolveProfileDirectory(config, appLogger(logs, "renderer")), undefined);
    assert.ok(lines.some((message) => message.includes("cold browser")));
  });
});
