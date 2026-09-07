/**
 * Builds one sample zip per category from real published catalyst items, for
 * the webview's "try an example" strip: apps/debug-ui/public/samples/<key>.zip
 * (a Builder-style zip: wearable.json/emote.json + the entity's files).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

const SUBGRAPH = "https://subgraph.decentraland.org/collections-matic-mainnet";
const PEER = "https://peer.decentraland.org";
const OUT = join(import.meta.dirname, "..", "..", "apps", "debug-ui", "public", "samples");
const CACHE = join(import.meta.dirname, "..", "..", "corpus", "blobs");
const MAX_BYTES = 4 * 1048576; // keep the repo lean — skip oversized candidates

const WEARABLE_CATEGORIES = [
  "hat", "upper_body", "lower_body", "feet", "hair", "eyewear", "mask",
  "earring", "tiara", "top_head", "helmet", "facial_hair", "hands_wear", "skin"
];

interface Entity {
  id: string;
  pointers: string[];
  content: { file: string; hash: string }[];
  metadata: Record<string, unknown> & {
    name?: string;
    rarity?: string;
    data?: { category?: string; hides?: string[]; replaces?: string[]; tags?: string[]; representations?: unknown[] };
    emoteDataADR74?: { category?: string; loop?: boolean; representations?: unknown[] };
  };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await mkdir(CACHE, { recursive: true });
  const index: { key: string; label: string; name: string; file: string; kind: "wearable" | "emote" }[] = [];

  for (const category of WEARABLE_CATEGORIES) {
    const entity = await findEntity(`itemType: "wearable_v2", searchWearableCategory: "${category}"`);
    if (!entity) { console.warn(`[samples] no candidate for ${category}`); continue; }
    const written = await writeSample(category, "wearable", entity);
    if (written) index.push({ key: category, label: category.replace("_", " "), name: entity.metadata.name ?? category, file: `${category}.zip`, kind: "wearable" });
  }

  const emote = await findEntity(`itemType: "emote_v1"`);
  if (emote) {
    const written = await writeSample("emote", "emote", emote);
    if (written) index.push({ key: "emote", label: "emote", name: emote.metadata.name ?? "emote", file: "emote.zip", kind: "emote" });
  }

  await writeFile(join(OUT, "index.json"), JSON.stringify(index, null, 2));
  console.log(`[samples] wrote ${index.length} samples + index.json`);
}

async function findEntity(where: string): Promise<Entity | null> {
  const query = `{ items(first: 6, orderBy: createdAt, orderDirection: desc,
    where: { ${where}, searchIsCollectionApproved: true }) { urn } }`;
  const res = await fetch(SUBGRAPH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const body = (await res.json()) as { data?: { items: { urn: string }[] } };
  const urns = body.data?.items.map((i) => i.urn) ?? [];
  if (urns.length === 0) return null;
  const entitiesRes = await fetch(`${PEER}/content/entities/active`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pointers: urns })
  });
  const entities = (await entitiesRes.json()) as Entity[];
  // prefer the smallest candidate under the size cap
  const sized = entities
    .map((e) => ({ e, bytes: 0 }))
    .sort((a, b) => a.e.content.length - b.e.content.length);
  return sized[0]?.e ?? null;
}

async function writeSample(key: string, kind: "wearable" | "emote", entity: Entity): Promise<boolean> {
  const zip = new JSZip();
  let total = 0;
  for (const { file, hash } of entity.content) {
    const bytes = await fetchBlob(hash);
    total += bytes.length;
    if (total > MAX_BYTES) { console.warn(`[samples] ${key}: over ${MAX_BYTES / 1048576} MB, skipped`); return false; }
    zip.file(file, bytes);
  }
  const meta = entity.metadata;
  const manifest =
    kind === "emote"
      ? {
          name: meta.name, rarity: meta.rarity,
          category: meta.emoteDataADR74?.category,
          play_mode: meta.emoteDataADR74?.loop ? "loop" : "simple",
          representations: meta.emoteDataADR74?.representations
        }
      : {
          name: meta.name, rarity: meta.rarity,
          data: {
            category: meta.data?.category, hides: meta.data?.hides ?? [], replaces: meta.data?.replaces ?? [],
            tags: meta.data?.tags ?? [], representations: meta.data?.representations ?? []
          }
        };
  zip.file(kind === "emote" ? "emote.json" : "wearable.json", JSON.stringify(manifest, null, 2));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await writeFile(join(OUT, `${key}.zip`), bytes);
  console.log(`[samples] ${key}.zip — ${meta.name} (${(bytes.length / 1048576).toFixed(2)} MB)`);
  return true;
}

async function fetchBlob(hash: string): Promise<Uint8Array> {
  const cached = join(CACHE, hash);
  if (existsSync(cached)) return new Uint8Array(await readFile(cached));
  const res = await fetch(`${PEER}/content/contents/${hash}`);
  if (!res.ok) throw new Error(`contents/${hash} ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(cached, bytes);
  return bytes;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
