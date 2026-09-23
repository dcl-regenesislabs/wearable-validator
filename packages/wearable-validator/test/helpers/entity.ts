import { unpackZip } from "../../src/loader.js";
import { contentHash } from "../../src/logic/content-hash.js";

/** What a catalyst answers for a pointer: the entity the run server and the site fetch, plus the bytes behind each hash. */
export interface SyntheticEntity {
  id: string;
  pointers: string[];
  content: { file: string; hash: string }[];
  metadata: Record<string, unknown>;
  files: Map<string, Uint8Array>;
}

const MANIFEST_NAMES = ["wearable.json", "emote.json"];

/**
 * The published form of a builder zip: its files hashed the way a catalyst addresses them, its wearable.json / emote.json
 * turned into entity metadata (a deployed entity carries no manifest file). The entity id is a hash of the content list.
 */
export async function syntheticEntity(zip: Uint8Array, urn: string, metadataOverrides: Record<string, unknown> = {}): Promise<SyntheticEntity> {
  const { files: unpacked } = await unpackZip(zip);
  const files = new Map<string, Uint8Array>();
  let manifest: Record<string, unknown> = {};
  for (const [path, bytes] of unpacked) {
    if (MANIFEST_NAMES.includes(path)) manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    else files.set(path, bytes);
  }
  // a deployed item also carries its rarity image; the builder zip has only the thumbnail, so it stands in
  const thumbnail = files.get("thumbnail.png");
  if (thumbnail && !files.has("image.png")) files.set("image.png", thumbnail);
  const content: { file: string; hash: string }[] = [];
  for (const [file, bytes] of files) content.push({ file, hash: await contentHash(bytes, 1) });
  const emote = unpacked.has("emote.json");
  const { name, description, rarity, data, ...rest } = manifest;
  const collectionAddress = /collections-v2:(0x[0-9a-f]{40})/i.exec(urn)?.[1] ?? "0x" + "0".repeat(40);
  const bothShapes = ["urn:decentraland:off-chain:base-avatars:BaseMale", "urn:decentraland:off-chain:base-avatars:BaseFemale"];
  const representations = (Array.isArray((data as { representations?: unknown[] } | undefined)?.representations) ? (data as { representations: Record<string, unknown>[] }).representations : [{ bodyShapes: bothShapes, mainFile: "model.glb", contents: ["model.glb"] }])
    .map((rep) => ({ overrideHides: [], overrideReplaces: [], ...rep }));
  // what @dcl/schemas requires of a standard (collection) wearable or emote entity, which the `metadata` check validates
  const common = { id: urn, name, description, rarity, thumbnail: "thumbnail.png", image: "image.png", collectionAddress, i18n: [{ code: "en", text: name }] };
  const metadata: Record<string, unknown> = emote
    ? { ...common, emoteDataADR74: { tags: [], loop: false, ...rest, representations }, ...metadataOverrides }
    : { ...common, data: { tags: [], hides: [], replaces: [], ...(data as Record<string, unknown>), representations }, ...metadataOverrides };
  const id = await contentHash(new TextEncoder().encode(JSON.stringify(content)), 1);
  return { id, pointers: [urn], content, metadata, files };
}

/** A fetch that answers like a catalyst for the given entities: pointer lookups and file downloads, nothing else. */
export function catalystFetch(entities: SyntheticEntity[], options: { status?: number; contentLength?: (file: string, bytes: Uint8Array) => string | undefined } = {}): typeof globalThis.fetch & { calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  const blobs = new Map<string, Uint8Array>();
  for (const entity of entities) for (const { file, hash } of entity.content ?? []) blobs.set(hash, entity.files.get(file)!);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body });
    if (options.status) return new Response("upstream error", { status: options.status });
    if (url.endsWith("/content/entities/active")) {
      const { pointers } = JSON.parse(body ?? "{}") as { pointers: string[] };
      const found = entities.filter((entity) => entity.pointers.some((pointer) => pointers.includes(pointer))).map(({ files, ...entity }) => entity);
      return new Response(JSON.stringify(found), { status: 200, headers: { "content-type": "application/json" } });
    }
    const hash = /\/content\/contents\/([^/?]+)$/.exec(url)?.[1];
    const bytes = hash ? blobs.get(hash) : undefined;
    if (!bytes) return new Response("not found", { status: 404 });
    const file = entities.flatMap((entity) => entity.content).find((entry) => entry.hash === hash)?.file ?? "";
    const declared = options.contentLength ? options.contentLength(file, bytes) : String(bytes.byteLength);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Response(copy, { status: 200, headers: declared === undefined ? {} : { "content-length": declared } });
  }) as typeof globalThis.fetch & { calls: { url: string; body?: string }[] };
  fetch.calls = calls;
  return fetch;
}
