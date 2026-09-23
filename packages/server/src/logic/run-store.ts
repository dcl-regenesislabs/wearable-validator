/** Run folders on disk (docs/visual-validation.md §3) and the index of every run this server has seen. */
import { mkdir, readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { START_COMPONENT, type IBaseComponent, type IConfigComponent, type ILoggerComponent } from "@well-known-components/interfaces";
import { digest, type CaptureRecord, type CaptureRequest, type CheckResult, type Finding, type Result, type ReviewRequest } from "@dcl-regenesislabs/wearable-validator";
import { reviewMessages } from "@dcl-regenesislabs/wearable-validator/ai";
import { appLogger } from "../adapters/log-buffer.js";
import type { RunEvent } from "../types.js";

const ROOT = resolve(import.meta.dirname, "../../../..");

export function readEvidenceFile(path: string): Promise<Buffer> {
  if (basename(path).startsWith(".env")) throw new Error("Choose an item or evidence file, not an environment file.");
  return readFile(path);
}

interface CaptureEntry {
  file: string;
  sha256: string;
  width: number;
  height: number;
  request: CaptureRequest;
}

/** input.json: who started the run and which zip it was — the server rebuilds its run index from it after a restart. */
export interface RunInput {
  id: string;
  owner: string;
  name: string;
  startedAt: number;
  sha256?: string;
  /** The code gate's verdict: a standalone run keeps rendering after a failed gate, and the index must still list it as failed. */
  gatePassed?: boolean | null;
}

/** result.json: the Result with capture bytes replaced by file paths inside the run folder. */
export interface StoredResult extends Omit<Result, "captures"> {
  captures: CaptureEntry[];
}

export function writeRunInput(dir: string, input: RunInput): Promise<void> {
  return writeFile(join(dir, "input.json"), JSON.stringify(input));
}

/** Fields are optional because folders written before ownership existed hold only { name, sha256 }. */
export async function readRunInput(dir: string): Promise<Partial<RunInput> | undefined> {
  const text = await readFile(join(dir, "input.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof value[key] === "string" ? value[key] : undefined);
  return { id: str("id"), owner: str("owner"), name: str("name"), startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined, sha256: str("sha256"), gatePassed: typeof value.gatePassed === "boolean" ? value.gatePassed : undefined };
}

export async function readRunResult(dir: string): Promise<StoredResult | undefined> {
  const text = await readFile(join(dir, "result.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as Partial<StoredResult>;
    return Array.isArray(raw.checks) && Array.isArray(raw.captures) ? (raw as StoredResult) : undefined;
  } catch {
    return undefined;
  }
}

/** One-glance verdict for a run list: validate()'s own when it has one; for visual-only runs, whether every row cleared. */
export function verdict(result: Pick<Result, "passed" | "checks">): boolean | null {
  if (result.passed !== null) return result.passed;
  if (result.checks.every((row) => row.status === "passed" || row.status === "warning")) return true;
  return result.checks.some((row) => row.status === "failed") ? false : null;
}

/** Rebuilds CaptureRecords from captures/captures.json + PNGs; resolveCaptures re-verifies each one. */
export async function readRun(dir: string): Promise<CaptureRecord[]> {
  const folder = join(dir, "captures");
  const raw: unknown = JSON.parse(await readEvidenceFile(join(folder, "captures.json")).then((bytes) => bytes.toString("utf8")));
  if (!Array.isArray(raw)) throw new Error(`${join(folder, "captures.json")} must hold the capture list of a previous review run.`);
  const captures: CaptureRecord[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || typeof value.file !== "string" || typeof value.sha256 !== "string" || !value.request) {
      throw new Error(`${join(folder, "captures.json")} holds an invalid capture entry. Run npm run review again to regenerate it.`);
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
export async function contextJson(request: ReviewRequest): Promise<Record<string, unknown>> {
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

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function usageLine(row: CheckResult): string {
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

// ---- the component -------------------------------------------------------------------------

export interface StoredRun {
  id: string;
  owner: string;
  name: string;
  dir: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
  /** Whether the run reached the renderer (input.json carries the zip's sha256 from that moment on): what the daily quota counts. */
  rendered: boolean;
}

export interface IRunStoreComponent extends IBaseComponent {
  readonly root: string;
  /** Resolves once the folders on disk are indexed; every lookup awaits it so a restart never hides a run. */
  ready(): Promise<void>;
  get(id: string): StoredRun | undefined;
  set(run: StoredRun): void;
  all(): StoredRun[];
  previousRun(sha256: string): string | undefined;
  rememberRun(sha256: string, dir: string): void;
  createRunDir(id: string, name: string): Promise<string>;
  writeInput(dir: string, input: RunInput): Promise<void>;
  /** The upload lives in the folder (input.zip): a waiting run holds no RAM, and the zip is served after the run. */
  writeUpload(dir: string, bytes: Uint8Array): Promise<void>;
  hasUpload(dir: string): Promise<boolean>;
  /** The item's own thumbnail, on disk before the first render so the site can show it while the views arrive. */
  writeThumbnail(dir: string, bytes: Uint8Array): Promise<void>;
  readUpload(dir: string): Promise<Uint8Array>;
  appendEvent(dir: string, event: RunEvent): Promise<void>;
  /** One capture as it lands, before writeRun() lists them all; the id is checked to be a safe file stem. */
  writeCapture(dir: string, id: string, bytes: Uint8Array): Promise<void>;
  writeRun(dir: string, result: Result, thumbnail?: Uint8Array): Promise<string>;
  readRun(dir: string): Promise<CaptureRecord[]>;
  readResult(dir: string): Promise<StoredResult | undefined>;
}

/** The default artifacts folder; a relative ARTIFACTS_DIR is taken from where the command was typed (INIT_CWD under npm -w). */
export function resolveArtifactsDir(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INIT_CWD ?? process.cwd(), configured ?? join(ROOT, "packages/server/artifacts"));
}

/**
 * Run folders remember which zip they came from and who started them (input.json): the newest per zip offers its
 * captures to the next run of the same file, and every owned folder is listed and served again after a restart.
 */
async function indexRunFolders(root: string, previous: Map<string, string>, index: Map<string, StoredRun>): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const reusable: { sha256: string; dir: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("visual-")) continue;
    const dir = join(root, entry);
    const input = await readRunInput(dir);
    if (!input) continue;
    if (input.sha256) {
      const info = await stat(join(dir, "captures", "captures.json")).catch(() => undefined);
      if (info) reusable.push({ sha256: input.sha256, dir, mtime: info.mtimeMs });
    }
    if (input.id && input.owner && !index.has(input.id)) {
      const result = await readRunResult(dir);
      index.set(input.id, { id: input.id, owner: input.owner, name: input.name ?? entry, dir, startedAt: input.startedAt ?? 0, done: true, passed: result ? (input.gatePassed === false ? false : verdict(result)) : null, rendered: input.sha256 !== undefined });
    }
  }
  for (const item of reusable.sort((a, b) => a.mtime - b.mtime)) if (!previous.has(item.sha256)) previous.set(item.sha256, item.dir);
}

export async function createRunStoreComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IRunStoreComponent> {
  const { config, logs } = components;
  const log = appLogger(logs, "run-store");
  const root = resolveArtifactsDir(await config.getString("ARTIFACTS_DIR"));
  const index = new Map<string, StoredRun>();
  const previous = new Map<string, string>();
  const indexed = indexRunFolders(root, previous, index).catch((error) => log.warn("could not index earlier runs", { error: error instanceof Error ? error.message : String(error) }));

  return {
    root,
    ready: () => indexed,
    [START_COMPONENT]: () => indexed,
    get: (id) => index.get(id),
    set: (run) => void index.set(run.id, run),
    all: () => [...index.values()],
    previousRun: (sha256) => previous.get(sha256),
    rememberRun: (sha256, dir) => void previous.set(sha256, dir),
    createRunDir: async (id, name) => {
      const dir = join(root, `visual-${name.replace(/\.zip$/i, "")}-${id}`);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    writeInput: writeRunInput,
    writeUpload: (dir, bytes) => writeFile(join(dir, "input.zip"), bytes),
    writeThumbnail: (dir, bytes) => writeFile(join(dir, "thumbnail.png"), bytes),
    hasUpload: (dir) => stat(join(dir, "input.zip")).then((info) => info.isFile(), () => false),
    readUpload: async (dir) => new Uint8Array(await readFile(join(dir, "input.zip"))),
    appendEvent: (dir, event) => appendFile(join(dir, "events.jsonl"), JSON.stringify(event) + "\n"),
    writeCapture: async (dir, id, bytes) => {
      if (!/^[\w.-]+$/.test(id)) throw new Error(`Capture id "${id}" is not a safe file stem.`);
      await mkdir(join(dir, "captures"), { recursive: true });
      await writeFile(join(dir, "captures", `${id}.png`), bytes);
    },
    writeRun,
    readRun,
    readResult: readRunResult
  };
}
