/**
 * CLI runner for the rendering group: code gate → adapters → validate() → run folder, from a terminal instead of the website.
 * Previous hop: `npm run review -- <item.zip>` with a Builder zip on disk.
 * Next hop: validate() selects the rendering checks; runs.ts writes the folder, reviewers.ts wraps the model call —
 * the same pieces server.ts streams to the web app.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadInput, registry, validate, type Result, type Services } from "@dcl-regenesislabs/wearable-validator";
import { createPiReviewer } from "@dcl-regenesislabs/wearable-validator/ai";
import { createRenderer } from "@dcl-regenesislabs/wearable-validator/rendering";
import { DRY_RUN_REASON, dryRunReviewer, recordingReviewer, replayReviewer, tokenCredentials } from "./reviewers.js";
import { readEvidenceFile, readRun, usageLine, writeRun } from "./runs.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const VISUAL_CHECKS = registry.filter((check) => check.group === "rendering").map((check) => check.name);

export interface Args {
  file: string;
  buildDirectory?: string;
  from?: string;
  answer: boolean;
  thumbnail?: string;
  standalone: boolean;
  noAi: boolean;
  cache: "none" | "short";
  out: string;
}

export function readArgs(argv = process.argv.slice(2)): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "renderer-build": { type: "string" },
      from: { type: "string" },
      answer: { type: "boolean", default: false },
      thumbnail: { type: "string" },
      standalone: { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      cache: { type: "string", default: "none" },
      out: { type: "string" }
    }
  });
  const usage = "Usage: review -- <item.zip> [--renderer-build <Build>] [--from <run dir>] [--answer] [--thumbnail <png>] [--standalone] [--no-ai] [--cache none|short] [--out packages/server/artifacts]";
  if (positionals.length !== 1) throw new Error(usage);
  if (values.answer && !values.from) throw new Error("--answer replays <run>/thumbnail-honesty/3-answer.json — add --from <run dir>.");
  if (!process.env.ANTHROPIC_OAUTH_SETUP_TOKEN && !values["no-ai"] && !values.answer) throw new Error(`Set ANTHROPIC_OAUTH_SETUP_TOKEN (a claude setup-token), or pass --no-ai to skip the model.\n${usage}`);
  if (values.cache !== "none" && values.cache !== "short") throw new Error("Choose --cache none or --cache short.");
  // npm -w runs scripts from packages/server; INIT_CWD is where the command was typed, so relative paths mean what the user sees
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const path = (value: string | undefined) => (value === undefined ? undefined : resolve(cwd, value));
  return {
    file: path(positionals[0])!,
    buildDirectory: path(values["renderer-build"]) ?? (existsSync(join(ROOT, "packages/server/renderer-build/avatar-preview-renderer.wasm")) ? join(ROOT, "packages/server/renderer-build") : undefined),
    from: path(values.from),
    answer: values.answer!,
    thumbnail: path(values.thumbnail),
    standalone: values.standalone!,
    noAi: values["no-ai"]!,
    cache: values.cache,
    out: path(values.out) ?? join(ROOT, "packages/server/artifacts")
  };
}

/** The zip bytes gate the run; the visual run gets the unpacked files so --thumbnail can replace one of them. */
export async function readItem(args: Args): Promise<{ bytes: Uint8Array; input: { files: Map<string, Uint8Array> }; thumbnail?: Uint8Array }> {
  const bytes = new Uint8Array(await readEvidenceFile(args.file));
  const loaded = await loadInput(bytes, {});
  if (!loaded.ctx) throw new Error("Provide a readable Builder wearable/emote ZIP with its thumbnail and representations.");
  const files = loaded.ctx.files;
  const thumbnailPath = loaded.ctx.item.thumbnailPath ?? "thumbnail.png";
  if (args.thumbnail) files.set(thumbnailPath, await readEvidenceFile(args.thumbnail));
  return { bytes, input: { files }, thumbnail: files.get(thumbnailPath) };
}

/** Repo-relative when inside the checkout (the documented commands run from the root), absolute otherwise. */
function display(path: string): string {
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? path : rel;
}

function printSummary(result: Result, index: string): void {
  for (const row of result.checks) {
    const count = result.findings.filter((finding) => finding.check === row.check).length;
    const parts = [row.check, row.status, `${count} finding${count === 1 ? "" : "s"}`, usageLine(row)].filter(Boolean);
    console.log(parts.join("  "));
    if (row.skipReason) console.log(`  ${row.skipReason}`);
  }
  for (const finding of result.findings) {
    const evidence = finding.evidence?.map((ref) => ref.captureId).join(", ");
    console.log(`  - ${finding.message}${finding.where ? ` (${finding.where})` : ""}${evidence ? `  evidence: ${evidence}` : ""}`);
  }
  console.log(`open ${display(index)}`);
}

async function main(): Promise<void> {
  const args = readArgs();
  const { bytes, input, thumbnail } = await readItem(args);
  // code gate is zero-cost: no browser, no OAuth until passed === true or --standalone; it judges the zip itself, not the unpacked files
  if (!args.standalone) {
    const code = await validate(bytes);
    if (code.passed !== true) {
      console.log(JSON.stringify({
        stage: "code",
        result: code,
        message: "Visual review was not started. Fix code failures or missing coverage; use --standalone to run V-05 individually."
      }, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  await mkdir(args.out, { recursive: true });
  const runDir = await mkdtemp(join(args.out, `visual-${basename(args.file).replace(/\.zip$/i, "")}-`));
  const captures = args.from ? await readRun(args.from) : undefined;
  const renderer = args.buildDirectory ? await createRenderer({ buildDirectory: args.buildDirectory }) : undefined;
  const reviewer = args.noAi ? dryRunReviewer()
    : args.answer ? replayReviewer(args.from!)
    : createPiReviewer({ credentials: tokenCredentials(process.env.ANTHROPIC_OAUTH_SETUP_TOKEN ?? ""), cache: args.cache });
  const services: Services = { renderer, reviewer: recordingReviewer(reviewer, runDir) };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  console.log(`Running ${VISUAL_CHECKS.join(", ")}: reusing ${captures?.length ?? 0} supplied views, rendering the rest, then one model call per review.\nRun folder: ${display(runDir)}`);
  try {
    const result = await validate(input, { checks: VISUAL_CHECKS, captures, services, signal: controller.signal });
    const index = await writeRun(runDir, result, thumbnail);
    printSummary(result, index);
    const dryRunCompleted = args.noAi && result.checks.every((row) => row.status === "passed" || (row.status === "errored" && Boolean(row.skipReason?.includes(DRY_RUN_REASON))));
    process.exitCode = result.checks.every((row) => row.status === "passed") || dryRunCompleted ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await renderer?.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Visual review failed.");
    process.exitCode = 1;
  });
}
