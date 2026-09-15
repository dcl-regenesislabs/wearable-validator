/**
 * Local runner for the rendering group: code gate → adapters → validate() → run folder.
 * Previous hop: a Builder zip on disk. Next hop: src/validate.ts selects thumbnail-honesty.
 * The only place createRenderer/createPiReviewer are constructed, and the only place the
 * boundary (captures, prompt, context, answer, finding) is written to disk — see docs/visual-validation.md §3.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";
import type { Context, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createPiReviewer, reviewMessages } from "../../packages/wearable-validator/src/adapters/ai.js";
import { digest } from "../../packages/wearable-validator/src/logic/captures.js";
import { loadInput } from "../../packages/wearable-validator/src/loader.js";
import { createRenderer } from "../../packages/wearable-validator/src/adapters/rendering.js";
import { registry } from "../../packages/wearable-validator/src/registry.js";
import { validate } from "../../packages/wearable-validator/src/validate.js";
import type {
  CaptureRecord, CaptureRequest, CheckResult, Finding, Result, Reviewer, ReviewRequest, ReviewResult, Services
} from "../../packages/wearable-validator/src/types.js";

// a `claude setup-token` (sk-ant-oat…) lives about a year and is itself the bearer, not a refresh token
const SETUP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** A hosted process gets the long-lived setup token by environment: seeded in memory as the access token so the SDK never tries to refresh it. */
export function tokenCredentials(token: string): CredentialStore {
  if (!token.startsWith("sk-ant-oat")) throw new Error("ANTHROPIC_OAUTH_SETUP_TOKEN must be a `claude setup-token` (sk-ant-oat…), not an API key.");
  let current: Credential | undefined = { type: "oauth", access: token, refresh: token, expires: Date.now() + SETUP_TOKEN_TTL_MS };
  return {
    async read(provider, options) {
      options?.signal?.throwIfAborted();
      return provider === "anthropic" ? current : undefined;
    },
    async list() {
      return current ? [{ providerId: "anthropic", type: "oauth" }] : [];
    },
    async modify(provider, fn) {
      if (provider !== "anthropic") throw new Error("This credential store supports Anthropic OAuth only.");
      const next = await fn(current);
      if (next && next.type !== "oauth") throw new Error("Only OAuth credentials can be stored here.");
      if (next) current = next;
      return next ?? current;
    },
    async delete(provider) {
      if (provider === "anthropic") current = undefined;
    }
  };
}

// dev-tool I/O, not a rule: refresh tokens are single-use and .auth.json is shared across terminals
const OAUTH_LOCK = { stale: 180000, retries: 10, minTimeout: 200, maxTimeout: 1000 };
const ROOT = resolve(import.meta.dirname, "../..");
const VISUAL_CHECKS = registry.filter((check) => check.group === "rendering").map((check) => check.name);
const DRY_RUN_REASON = "The model was not called (--no-ai).";

export interface Args {
  file: string;
  auth?: string;
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
      auth: { type: "string" },
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
  const usage = "Usage: visual:review -- <item.zip> [--auth <session.json>] [--renderer-build <Build>] [--from <run dir>] [--answer] [--thumbnail <png>] [--standalone] [--no-ai] [--cache none|short] [--out tools/artifacts]";
  if (positionals.length !== 1) throw new Error(usage);
  if (values.answer && !values.from) throw new Error("--answer replays <run>/thumbnail-honesty/3-answer.json — add --from <run dir>.");
  if (!values.auth && !process.env.ANTHROPIC_OAUTH_SETUP_TOKEN && !values["no-ai"] && !values.answer) throw new Error(`Pass --auth <session.json>, set ANTHROPIC_OAUTH_SETUP_TOKEN, or --no-ai to skip the model.\n${usage}`);
  if (values.cache !== "none" && values.cache !== "short") throw new Error("Choose --cache none or --cache short.");
  // npm -w runs scripts from tools/; INIT_CWD is where the command was typed, so relative paths mean what the user sees
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const path = (value: string | undefined) => (value === undefined ? undefined : resolve(cwd, value));
  return {
    file: path(positionals[0])!,
    auth: path(values.auth),
    buildDirectory: path(values["renderer-build"]) ?? (existsSync(join(ROOT, "tools/renderer-build/avatar-preview-renderer.wasm")) ? join(ROOT, "tools/renderer-build") : undefined),
    from: path(values.from),
    answer: values.answer!,
    thumbnail: path(values.thumbnail),
    standalone: values.standalone!,
    noAi: values["no-ai"]!,
    cache: values.cache,
    out: path(values.out) ?? join(ROOT, "tools/artifacts")
  };
}

export function readEvidenceFile(path: string): Promise<Buffer> {
  if (basename(path).startsWith(".env")) throw new Error("Choose an item or evidence file, not an environment file.");
  return readFile(path);
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

// refresh tokens are single-use and the file is shared across terminals: lock, write <file>.<uuid>.tmp 0o600, rename; refuses api_key and .env* basenames
export function fileCredentials(path: string): CredentialStore {
  if (basename(path).startsWith(".env")) throw new Error("Use a dedicated OAuth session JSON file, not an environment file.");
  async function readDocument(target: string): Promise<Record<string, unknown>> {
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The OAuth session file must contain an object.");
    return value as Record<string, unknown>;
  }
  function credential(document: Record<string, unknown>): Credential | undefined {
    const value = document.anthropic;
    if (value === undefined) return undefined;
    if (
      !value || typeof value !== "object" ||
      !("type" in value) || value.type !== "oauth" ||
      !("access" in value) || typeof value.access !== "string" ||
      !("refresh" in value) || typeof value.refresh !== "string" ||
      !("expires" in value) || typeof value.expires !== "number" || !Number.isFinite(value.expires)
    ) {
      throw new Error("The session file needs a valid Anthropic OAuth credential.");
    }
    return { ...value, type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires };
  }
  async function modify(fn: (document: Record<string, unknown>) => Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const target = await realpath(path);
    const release = await lockfile.lock(target, {
      stale: OAUTH_LOCK.stale,
      retries: { retries: OAUTH_LOCK.retries, minTimeout: OAUTH_LOCK.minTimeout, maxTimeout: OAUTH_LOCK.maxTimeout }
    });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      signal?.throwIfAborted();
      const document = await readDocument(target);
      const before = JSON.stringify(document);
      await fn(document);
      signal?.throwIfAborted();
      if (JSON.stringify(document) !== before) {
        await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      }
    } finally {
      await unlink(temporary).catch(() => {});
      await release();
    }
  }
  return {
    async read(provider, options) {
      options?.signal?.throwIfAborted();
      return provider === "anthropic" ? credential(await readDocument(path)) : undefined;
    },
    async list(options) {
      const value = await this.read("anthropic", options);
      return value ? [{ providerId: "anthropic", type: "oauth" }] : [];
    },
    async modify(provider, fn, options) {
      if (provider !== "anthropic") throw new Error("This credential store supports Anthropic OAuth only.");
      let updated: Credential | undefined;
      await modify(async (document) => {
        const current = credential(document);
        const next = await fn(current);
        if (next && next.type !== "oauth") throw new Error("Only OAuth credentials can be stored here.");
        if (next) document.anthropic = next;
        updated = next ?? current;
      }, options?.signal);
      return updated;
    },
    async delete(provider, options) {
      if (provider === "anthropic") {
        await modify(async (document) => {
          delete document.anthropic;
        }, options?.signal);
      }
    }
  };
}

interface CaptureEntry {
  file: string;
  sha256: string;
  width: number;
  height: number;
  request: CaptureRequest;
}

/** Rebuilds CaptureRecords from captures/captures.json + PNGs; resolveCaptures re-verifies each one. */
export async function readRun(dir: string): Promise<CaptureRecord[]> {
  const folder = join(dir, "captures");
  const raw: unknown = JSON.parse(await readEvidenceFile(join(folder, "captures.json")).then((bytes) => bytes.toString("utf8")));
  if (!Array.isArray(raw)) throw new Error(`${join(folder, "captures.json")} must hold the capture list of a previous visual:review run.`);
  const captures: CaptureRecord[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || typeof value.file !== "string" || typeof value.sha256 !== "string" || !value.request) {
      throw new Error(`${join(folder, "captures.json")} holds an invalid capture entry. Re-run visual:review to regenerate it.`);
    }
    const entry = value as CaptureEntry;
    // a deleted PNG is a missing view: resolveCaptures renders it again (with --renderer-build) or reports it
    const bytes = await readEvidenceFile(join(folder, basename(entry.file))).catch(() => undefined);
    if (!bytes) continue;
    captures.push({ request: entry.request, bytes: new Uint8Array(bytes), sha256: entry.sha256, width: entry.width, height: entry.height });
  }
  return captures;
}

/** Where an image lives relative to the per-check folder: the thumbnail beside the captures, every capture by id. */
function imageFile(id: string): string {
  return id === "thumbnail" ? "../thumbnail.png" : `../captures/${id}.png`;
}

/** The conversation a human reads: system, images in send order, instructions, schema. */
export function promptMarkdown(request: ReviewRequest): string {
  const images = request.images.map((image, index) => `${index + 1}. \`Image ID: ${image.id}\` — ${image.label} — ![](${imageFile(image.id)})`);
  return [
    `# ${request.check} · prompt v${request.prompt.version} · digest ${request.promptDigest}`,
    "## System", request.prompt.system,
    "## Images (send order)", images.join("\n"),
    "## Instructions", request.prompt.instructions,
    "## Schema", JSON.stringify(request.prompt.schema, null, 2), ""
  ].join("\n");
}

/** The pi-ai Context exactly as built for the call, with image data replaced by a file reference. */
async function contextJson(request: ReviewRequest): Promise<Record<string, unknown>> {
  const context: Context = reviewMessages(request);
  let index = 0;
  const messages: unknown[] = [];
  for (const message of context.messages) {
    if (message.role !== "user" || typeof message.content === "string") {
      messages.push(message);
      continue;
    }
    const content: unknown[] = [];
    for (const block of message.content) {
      if (block.type !== "image") {
        content.push(block);
        continue;
      }
      // images are sent in request order — the nth image block is request.images[n]
      const image = request.images[index++];
      content.push({ type: "image", id: image.id, file: imageFile(image.id), sha256: await digest(image.bytes), mimeType: image.mimeType });
    }
    messages.push({ ...message, content });
  }
  return { ...context, messages };
}

/** Writes <check>/1-prompt.md and 2-context.json BEFORE forwarding, 3-answer.json after — so --no-ai still leaves the prompt on disk. */
export function recordingReviewer(reviewer: Reviewer, dir: string): Reviewer {
  return {
    async review(request, signal) {
      const folder = join(dir, request.check);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "1-prompt.md"), promptMarkdown(request));
      await writeFile(join(folder, "2-context.json"), JSON.stringify(await contextJson(request), null, 2));
      const result = await reviewer.review(request, signal);
      await writeFile(join(folder, "3-answer.json"), JSON.stringify(result, null, 2));
      return result;
    }
  };
}

/** --no-ai: renders and records the prompt, never calls the model; the row becomes errored with this reason. */
export function dryRunReviewer(): Reviewer {
  return {
    async review(request) {
      return {
        ok: false,
        reason: DRY_RUN_REASON,
        metadata: { provider: "none", model: "none", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
      };
    }
  };
}

/** --from <run> --answer: replays each check's saved 3-answer.json through the checks with zero network. */
export function replayReviewer(runDir: string): Reviewer {
  return {
    async review(request) {
      const answerPath = join(runDir, request.check, "3-answer.json");
      const saved: unknown = JSON.parse((await readEvidenceFile(answerPath)).toString("utf8"));
      if (!saved || typeof saved !== "object" || typeof (saved as { ok?: unknown }).ok !== "boolean" || !("metadata" in saved)) {
        throw new Error(`${answerPath} is not a saved ReviewResult. Run visual:review with --auth first.`);
      }
      const result = saved as ReviewResult;
      if (result.metadata.promptDigest !== request.promptDigest) {
        console.error(`Warning: ${answerPath} was produced for prompt digest ${result.metadata.promptDigest}, the current prompt is ${request.promptDigest}.`);
      }
      // echo the request's digest — the answer is replayed against this prompt on purpose
      const metadata = { ...result.metadata, promptVersion: request.prompt.version, promptDigest: request.promptDigest };
      return result.ok ? { ok: true, answer: result.answer, metadata } : { ok: false, reason: result.reason, metadata };
    }
  };
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function usageLine(row: CheckResult): string {
  const usage = row.review?.usage;
  if (!usage) return "";
  return `$${usage.cost.toFixed(3)}  ${usage.input.toLocaleString("en-US")} in / ${usage.output.toLocaleString("en-US")} out`;
}

/** Gallery: one section per rendering row, thumbnail beside the captures, findings linking #<captureId>. */
export function galleryHtml(result: Result, attachments: Record<string, Record<string, string>> = {}): string {
  const rows = result.checks.filter((row) => row.group === "rendering");
  const sections = rows.map((row) => {
    const findings = result.findings.filter((finding) => finding.check === row.check).map((finding) => {
      const links = finding.evidence?.map((ref) => `<a href="#${escape(ref.captureId)}">${escape(ref.captureId)}</a>`).join(" ") ?? "";
      return `<li>${escape(finding.message)}${finding.where ? ` <code>${escape(finding.where)}</code>` : ""} ${links}</li>`;
    });
    const usage = usageLine(row);
    const details = Object.entries(attachments[row.check] ?? {}).map(
      ([name, text]) => `<details><summary>${escape(name)}</summary><pre>${escape(text)}</pre></details>`
    );
    return `<section><h1>${escape(row.check)}: ${escape(row.status)}</h1><p>${escape(row.measured ?? row.skipReason ?? "")}</p>` +
      (usage ? `<p>${escape(usage)}${row.review ? ` · ${escape(row.review.model)}` : ""}</p>` : "") +
      `<ul>${findings.join("\n")}</ul>${details.join("\n")}</section>`;
  });
  const cards = result.captures.map(({ request }) =>
    `<figure id="${escape(request.id)}"><img src="captures/${escape(request.id)}.png"><figcaption>${escape(request.id)}</figcaption></figure>`
  );
  cards.unshift('<figure id="thumbnail"><img src="thumbnail.png"><figcaption>thumbnail</figcaption></figure>');
  return `<!doctype html><meta charset="utf-8"><title>Visual review</title>
<style>body{font:16px system-ui;background:#222;color:#eee;padding:24px}main{display:flex;flex-wrap:wrap}figure{margin:12px}img{width:320px;max-width:100%}a{color:#bc8cff}pre{white-space:pre-wrap;max-height:60vh;overflow:auto;background:#111;padding:12px}</style>
${sections.join("\n")}<a href="result.json">result.json</a><main>${cards.join("\n")}</main>`;
}

/** Serializes only what crossed the validate() boundary: result.json, thumbnail.png, captures/, <check>/4-finding.json, index.html. */
export async function writeRun(dir: string, result: Result, thumbnail?: Uint8Array): Promise<string> {
  const folder = join(dir, "captures");
  await mkdir(folder, { recursive: true });
  const entries: CaptureEntry[] = [];
  const seen = new Set<string>();
  for (const capture of result.captures) {
    const { id } = capture.request;
    if (!/^[\w.-]+$/.test(id)) throw new Error(`Capture id "${id}" is not a safe file stem.`);
    if (seen.has(id)) throw new Error(`Two captures share the id "${id}"; the run folder cannot hold both.`);
    seen.add(id);
    await writeFile(join(folder, `${id}.png`), capture.bytes);
    entries.push({ file: `${id}.png`, sha256: capture.sha256, width: capture.width, height: capture.height, request: capture.request });
  }
  await writeFile(join(folder, "captures.json"), JSON.stringify(entries, null, 2));
  const captures = entries.map(({ file, ...entry }) => ({ ...entry, file: `captures/${file}` }));
  await writeFile(join(dir, "result.json"), JSON.stringify({ ...result, captures }, null, 2));
  if (thumbnail) await writeFile(join(dir, "thumbnail.png"), thumbnail);
  const attachments: Record<string, Record<string, string>> = {};
  for (const row of result.checks.filter((row) => row.group === "rendering")) {
    const checkDir = join(dir, row.check);
    await mkdir(checkDir, { recursive: true });
    const findings: Finding[] = result.findings.filter((finding) => finding.check === row.check);
    await writeFile(join(checkDir, "4-finding.json"), JSON.stringify({ check: row, findings }, null, 2));
    attachments[row.check] = {};
    for (const name of ["1-prompt.md", "2-context.json", "3-answer.json"]) {
      const text = await readFile(join(checkDir, name), "utf8").catch(() => undefined);
      if (text !== undefined) attachments[row.check][name] = text;
    }
  }
  const index = join(dir, "index.html");
  await writeFile(index, galleryHtml(result, attachments));
  return index;
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
    : createPiReviewer({ credentials: args.auth ? fileCredentials(args.auth) : tokenCredentials(process.env.ANTHROPIC_OAUTH_SETUP_TOKEN ?? ""), cache: args.cache });
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
