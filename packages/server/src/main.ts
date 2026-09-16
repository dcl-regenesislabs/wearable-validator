/**
 * Entry point of the run server: configuration (flags win over environment variables — the environment is how a
 * hosted process is configured), adapter wiring, listen, SIGTERM shutdown.
 * Previous hop: `npm start -w wearable-validator-server` (the Dockerfile CMD) or `npm run serve` at the repo root.
 * Next hop: server.ts createRunServer() answers the routes; reviewers.ts wraps the model call of every run.
 */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { createPiReviewer } from "@dcl-regenesislabs/wearable-validator/ai";
import { createRenderer } from "@dcl-regenesislabs/wearable-validator/rendering";
import { createAccessVerifier } from "./access.js";
import { accessIdentity, localIdentity, type Identify } from "./identity.js";
import { createLogger } from "./log.js";
import { dryRunReviewer, liveReviewer, recordingReviewer, tokenCredentials } from "./reviewers.js";
import { createRunServer, isLoopback } from "./server.js";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Who owns runs: Cloudflare Access when configured, the machine's user on loopback, nobody in particular only when asked for. */
function chooseIdentity(env: NodeJS.ProcessEnv, host: string): { identify: Identify; kind: string } {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (teamDomain || audience) {
    if (!teamDomain || !audience) throw new Error("Set both CF_ACCESS_TEAM_DOMAIN (the team slug) and CF_ACCESS_AUD (the Access application audience tag).");
    return { identify: accessIdentity(createAccessVerifier({ teamDomain, audience })), kind: `cloudflare-access (${teamDomain})` };
  }
  if (isLoopback(host)) return { identify: localIdentity(), kind: "local" };
  if (env.INSECURE_ANONYMOUS === "1") return { identify: localIdentity("anonymous"), kind: "anonymous" };
  throw new Error(`HOST=${host} is reachable from other machines: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or INSECURE_ANONYMOUS=1 on a trusted network only.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "renderer-build": { type: "string" },
      "no-ai": { type: "boolean", default: false },
      site: { type: "string" },
      out: { type: "string" }
    }
  });
  const env = process.env;
  const cwd = env.INIT_CWD ?? process.cwd();
  const log = createLogger();
  // packages/server/renderer-build is the gitignored home for the PR #10053 Unity build, so the flag is optional once it is there
  const defaultBuild = join(ROOT, "packages/server/renderer-build");
  const buildFlag = values["renderer-build"] ?? env.RENDERER_BUILD;
  const buildDirectory = buildFlag
    ? resolve(cwd, buildFlag)
    : await stat(join(defaultBuild, "avatar-preview-renderer.wasm")).then(() => defaultBuild).catch(() => undefined);
  // the only credential is the year-long `claude setup-token` from the environment: no session file, nothing to refresh or persist
  const setupToken = values["no-ai"] ? undefined : env.ANTHROPIC_OAUTH_SETUP_TOKEN;
  const credentials = setupToken ? tokenCredentials(setupToken) : undefined;
  const out = resolve(cwd, values.out ?? env.ARTIFACTS_DIR ?? join(ROOT, "packages/server/artifacts"));
  const site = resolve(cwd, values.site ?? env.SITE_DIR ?? join(ROOT, "packages/web/dist"));
  const siteExists = await stat(join(site, "index.html")).then(() => true).catch(() => false);
  const port = Number(values.port ?? env.PORT ?? 4180);
  const host = values.host ?? env.HOST ?? "127.0.0.1";
  const publicHosts = (env.PUBLIC_HOSTS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const identity = chooseIdentity(env, host);
  const reviewerKind = credentials ? "pi" : "dry-run";
  if (identity.kind === "anonymous") log.warn("INSECURE_ANONYMOUS=1: every caller owns every run and nobody signs in; never expose this server beyond a trusted network", { host });
  if (!credentials) log.warn("no OAuth session: reviews render and write the prompt without calling the model (set ANTHROPIC_OAUTH_SETUP_TOKEN to a claude setup-token)");
  if (!buildDirectory) log.warn("no Unity build found: visual runs will skip rendering (put the PR #10053 build in packages/server/renderer-build or pass --renderer-build)");

  const { server, close } = createRunServer({
    out,
    host,
    publicHosts,
    maxConcurrentRuns: Number(env.MAX_CONCURRENT_RUNS ?? 1),
    identify: identity.identify,
    logger: log,
    capabilities: { renderer: Boolean(buildDirectory), reviewer: reviewerKind },
    site: siteExists ? site : undefined,
    services: async (run) => {
      const renderer = buildDirectory ? await createRenderer({ buildDirectory, onCapture: (capture) => void run.capture(capture) }) : undefined;
      const base = credentials ? createPiReviewer({ credentials }) : dryRunReviewer();
      const reviewer = liveReviewer(recordingReviewer(base, run.dir), run);
      return { renderer, reviewer, stop: () => renderer?.stop() ?? Promise.resolve() };
    }
  });
  server.listen(port, host, () => {
    log.info("run server listening", {
      url: `http://${host}:${port}`, renderer: buildDirectory ? "local Unity build" : "none", reviewer: reviewerKind,
      model: credentials ? manifest.ai.model : undefined, auth: setupToken ? "setup token" : "none", identity: identity.kind, concurrentRuns: Number(env.MAX_CONCURRENT_RUNS ?? 1), rules: manifest.version, artifacts: out,
      site: siteExists ? `http://${host}:${port}/` : "not built (run npm run build -w wearable-validator-web, or use the Vite dev server)"
    });
  });
  // a hosted process gets SIGTERM on deploy: stop accepting, abort what is running, close the browser, then exit
  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    void close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : "The run server failed to start.");
  process.exitCode = 1;
});
