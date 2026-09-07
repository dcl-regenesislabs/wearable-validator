/**
 * Downloads real published wearables & emotes from catalyst and runs the validator over them.
 *
 *   npm run catalyst -w wearable-validator-tools -- [--wearables 15] [--emotes 10] [--json out.json]
 *
 * Read-only public HTTP: collections subgraph (item urns) → peer /content/entities/active
 * (entity metadata + content list) → /content/contents/{hash} (files, cached on disk).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../../packages/wearable-validator/src/index.js";
import type { Finding, Result } from "../../packages/wearable-validator/src/index.js";

const SUBGRAPH = "https://subgraph.decentraland.org/collections-matic-mainnet";
const PEER = "https://peer.decentraland.org";
const CACHE = join(import.meta.dirname, "..", "corpus", "blobs");
const CONCURRENCY = 6;

interface SubgraphItem { urn: string; itemType: string; searchWearableCategory?: string; searchEmoteCategory?: string }
interface Entity {
  id: string;
  pointers: string[];
  timestamp: number;
  content: { file: string; hash: string }[];
  metadata: Record<string, unknown> & { name?: string };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, def: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : def;
  };
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  const wearableCount = flag("wearables", 15);
  const emoteCount = flag("emotes", 10);

  console.log(`[catalyst] listing ${wearableCount} wearables + ${emoteCount} emotes (recent, committee-approved)…`);
  const wearables = await listItems("wearable_v2", wearableCount);
  const emotes = await listItems("emote_v1", emoteCount);
  const urns = [...wearables, ...emotes].map((i) => i.urn);

  console.log(`[catalyst] resolving ${urns.length} entities…`);
  const entities = await fetchEntities(urns);
  console.log(`[catalyst] downloading files (${entities.reduce((n, e) => n + e.content.length, 0)} refs, cached in corpus/blobs)…`);

  await mkdir(CACHE, { recursive: true });
  const rows: ReportRow[] = [];
  for (const entity of entities) {
    const row = await runOne(entity);
    rows.push(row);
    const icon = row.error ? "!" : row.errors > 0 ? "✖" : row.warnings > 0 ? "⚠" : "✔";
    console.log(`${icon} ${row.type.padEnd(8)} ${row.name.slice(0, 42).padEnd(44)} errors=${row.errors} warnings=${row.warnings} checked=${row.checked}${row.error ? `  RUN ERROR: ${row.error}` : ""}`);
  }

  summarize(rows);
  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify(rows, null, 2));
    console.log(`[catalyst] full report written to ${jsonOut}`);
  }
}

interface ReportRow {
  urn: string;
  name: string;
  type: string;
  category?: string;
  errors: number;
  warnings: number;
  checked: number;
  passed: boolean | null;
  findings: Pick<Finding, "check" | "severity" | "message" | "where">[];
  error?: string;
}

async function runOne(entity: Entity): Promise<ReportRow> {
  const isEmote = "emoteDataADR74" in entity.metadata;
  const base: Omit<ReportRow, "errors" | "warnings" | "checked" | "passed" | "findings"> = {
    urn: entity.pointers[0] ?? entity.id,
    name: entity.metadata.name ?? entity.id,
    type: isEmote ? "emote" : "wearable",
    category: ((entity.metadata as { data?: { category?: string } }).data?.category ??
      (entity.metadata as { emoteDataADR74?: { category?: string } }).emoteDataADR74?.category)
  };
  try {
    const files = new Map<string, Uint8Array>();
    for (const { file, hash } of entity.content) {
      files.set(file, await fetchBlob(hash));
    }
    const result: Result = await validate({ files, metadata: entity.metadata, content: entity.content });
    return {
      ...base,
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      checked: result.summary.checked,
      passed: result.passed,
      findings: result.findings.map((f) => ({ check: f.check, severity: f.severity, message: f.message, where: f.where }))
    };
  } catch (err) {
    return { ...base, errors: 0, warnings: 0, checked: 0, passed: null, findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function listItems(itemType: "wearable_v2" | "emote_v1", count: number): Promise<SubgraphItem[]> {
  const query = `{
    items(first: ${count}, orderBy: createdAt, orderDirection: desc,
          where: { itemType: "${itemType}", searchIsCollectionApproved: true }) {
      urn itemType searchWearableCategory searchEmoteCategory
    }
  }`;
  const res = await fetch(SUBGRAPH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`subgraph ${res.status}`);
  const body = (await res.json()) as { data?: { items: SubgraphItem[] }; errors?: unknown };
  if (!body.data) throw new Error(`subgraph error: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data.items;
}

async function fetchEntities(pointers: string[]): Promise<Entity[]> {
  const res = await fetch(`${PEER}/content/entities/active`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pointers })
  });
  if (!res.ok) throw new Error(`entities/active ${res.status}`);
  return (await res.json()) as Entity[];
}

const inflight = new Map<string, Promise<Uint8Array>>();
let active = 0;
const queue: (() => void)[] = [];

async function fetchBlob(hash: string): Promise<Uint8Array> {
  const cached = join(CACHE, hash);
  if (existsSync(cached)) return new Uint8Array(await readFile(cached));
  const existing = inflight.get(hash);
  if (existing) return existing;
  const promise = (async () => {
    while (active >= CONCURRENCY) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      const res = await fetch(`${PEER}/content/contents/${hash}`);
      if (!res.ok) throw new Error(`contents/${hash} ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await writeFile(cached, bytes);
      return bytes;
    } finally {
      active--;
      queue.shift()?.();
    }
  })();
  inflight.set(hash, promise);
  return promise;
}

function summarize(rows: ReportRow[]): void {
  const ok = rows.filter((r) => !r.error);
  const clean = ok.filter((r) => r.errors === 0);
  console.log(`\n[catalyst] ${rows.length} items · ${clean.length} with zero errors · ${ok.length - clean.length} with errors · ${rows.length - ok.length} run failures`);
  const byCheck = new Map<string, number>();
  for (const row of ok) for (const f of row.findings) byCheck.set(`${f.severity}:${f.check}`, (byCheck.get(`${f.severity}:${f.check}`) ?? 0) + 1);
  const sorted = [...byCheck.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length) {
    console.log(`[catalyst] findings by check:`);
    for (const [key, n] of sorted) console.log(`   ${String(n).padStart(4)}  ${key}`);
  }
}

main().catch((err) => {
  console.error(`[catalyst] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
