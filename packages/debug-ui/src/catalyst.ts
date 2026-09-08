/**
 * Analyze a published item straight from catalyst: paste a URN or a
 * marketplace URL, fetch the entity + files browser-side (catalyst CORS is
 * open), and hand the validator the same {files, metadata, content} the
 * platform itself would.
 */
const PEER = "https://peer.decentraland.org";
const CONCURRENCY = 6;

export interface CatalystItem {
  urn: string;
  name: string;
  files: Map<string, Uint8Array>;
  metadata: unknown;
  content: { file: string; hash: string }[];
}

/** urn:decentraland:...:collections-v2:0x…:0 · collections-v1 · marketplace /contracts/0x…/items/0 URLs. */
export function parseItemReference(raw: string): string[] | null {
  const input = raw.trim();
  if (/^urn:decentraland:[a-z]+:collections-v[12]:/i.test(input)) return [input.toLowerCase()];
  const url = input.match(/marketplace\/contracts\/(0x[0-9a-fA-F]{40})\/items\/(\d+)/);
  if (url) {
    const [, contract, item] = url;
    // The URL doesn't say which chain — try matic first (99% of items), then ethereum.
    return [
      `urn:decentraland:matic:collections-v2:${contract.toLowerCase()}:${item}`,
      `urn:decentraland:ethereum:collections-v2:${contract.toLowerCase()}:${item}`
    ];
  }
  if (input.includes("marketplace") && input.includes("/tokens/")) {
    throw new Error("That's an NFT token page — open the item's page instead (the URL should contain /items/<number>).");
  }
  return null;
}

export async function fetchItem(candidates: string[], onProgress: (msg: string) => void): Promise<CatalystItem> {
  onProgress("looking up the item on catalyst…");
  interface ActiveEntity {
    pointers: string[];
    content: { file: string; hash: string }[];
    metadata: Record<string, unknown> & { name?: string };
  }
  let entity: ActiveEntity | null = null;
  let urn = candidates[0];
  for (const candidate of candidates) {
    const res = await fetch(`${PEER}/content/entities/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pointers: [candidate] })
    });
    if (!res.ok) throw new Error(`catalyst answered ${res.status} — try again in a moment`);
    const entities = (await res.json()) as ActiveEntity[];
    if (entities.length > 0) {
      entity = entities[0];
      urn = candidate;
      break;
    }
  }
  if (!entity) throw new Error("No published item found for that reference — check the URN/URL, or the item may not be published yet.");

  const files = new Map<string, Uint8Array>();
  let done = 0;
  const queue = [...entity.content];
  onProgress(`downloading ${queue.length} files…`);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const res = await fetch(`${PEER}/content/contents/${next.hash}`);
      if (!res.ok) throw new Error(`file download failed (${res.status}) for ${next.file}`);
      files.set(next.file, new Uint8Array(await res.arrayBuffer()));
      done++;
      onProgress(`downloading files… ${done}/${entity!.content.length}`);
    }
  });
  await Promise.all(workers);

  return { urn, name: entity.metadata.name ?? urn, files, metadata: entity.metadata, content: entity.content };
}
