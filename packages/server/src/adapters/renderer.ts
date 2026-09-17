/** The Unity renderer as a component: one browser per run, its captures and diagnostics routed to the run's stream and the log. */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { Renderer } from "@dcl-regenesislabs/wearable-validator";
import { createRenderer } from "@dcl-regenesislabs/wearable-validator/rendering";
import type { RunSink } from "../types.js";
import { appLogger } from "./log-buffer.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
// packages/server/renderer-build is the gitignored home for the PR #10053 Unity build, so RENDERER_BUILD is optional once it is there
const DEFAULT_BUILD = join(ROOT, "packages/server/renderer-build");

export interface IRendererComponent {
  readonly available: boolean;
  readonly buildDirectory?: string;
  /** Undefined when no build is configured. */
  forRun(run: RunSink): Promise<Renderer | undefined>;
}

/** RENDERER_BUILD when set (relative to where the command was typed), else the default folder when its wasm is there. */
export async function resolveBuildDirectory(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (configured) return resolve(env.INIT_CWD ?? process.cwd(), configured);
  return stat(join(DEFAULT_BUILD, "avatar-preview-renderer.wasm")).then(() => DEFAULT_BUILD).catch(() => undefined);
}

export async function createRendererComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IRendererComponent> {
  const { config, logs } = components;
  const log = appLogger(logs, "renderer");
  const buildDirectory = await resolveBuildDirectory(await config.getString("RENDERER_BUILD"));
  // the library reads CHROMIUM_ARGS from the process environment at launch; a value that only the config knows (a test map) is handed over here
  const chromiumArgs = await config.getString("CHROMIUM_ARGS");
  if (chromiumArgs !== undefined && process.env.CHROMIUM_ARGS === undefined) process.env.CHROMIUM_ARGS = chromiumArgs;
  if (!buildDirectory) log.warn("no Unity build found: visual runs will skip rendering (put the PR #10053 build in packages/server/renderer-build or set RENDERER_BUILD)");
  // a slow host (few vCPUs, software rendering) needs longer per previewer command than the manifest assumes
  const timeouts = {
    commandTimeoutMs: await config.getNumber("RENDER_COMMAND_TIMEOUT_MS"),
    loadTimeoutMs: await config.getNumber("RENDER_LOAD_TIMEOUT_MS"),
    timeoutMs: await config.getNumber("RENDER_TOTAL_TIMEOUT_MS")
  };
  const overrides = Object.fromEntries(Object.entries(timeouts).filter(([, value]) => value !== undefined));
  if (Object.keys(overrides).length) log.info("render timeouts overridden", overrides);
  return {
    available: Boolean(buildDirectory),
    buildDirectory,
    forRun: async (run) =>
      buildDirectory
        ? createRenderer({ buildDirectory, timeouts: overrides, onCapture: (capture) => void run.capture(capture), onLog: (message, fields) => log.info(message, { run: run.id, ...fields }) })
        : undefined
  };
}
