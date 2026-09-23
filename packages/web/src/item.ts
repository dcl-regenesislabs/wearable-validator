import { InputLimitError, unpackZip } from "@dcl-regenesislabs/wearable-validator";

/** The item on the Validate tab: a dropped file, a bundled sample or a catalyst entity. */
export interface Loaded {
  name: string;
  bytes?: Uint8Array;
  isBareGlb: boolean;
  /** Published-item analysis: entity files + metadata fetched from catalyst, under this URN. */
  urn?: string;
  files?: Map<string, Uint8Array>;
  metadata?: unknown;
  content?: { file: string; hash: string }[];
  /** Category read from a zip's embedded manifest (limit display). */
  zipMetadata?: unknown;
  zipMetadataSource?: string;
  zipCategory?: string;
  zipHides?: string[];
  zipFiles?: Map<string, Uint8Array>;
}

export interface Sample {
  key: string;
  label: string;
  name: string;
  file: string;
  kind: "wearable" | "emote";
}

export type ZipContext = Pick<Loaded, "zipCategory" | "zipHides" | "zipMetadata" | "zipMetadataSource" | "zipFiles">;

export async function zipRuleContext(bytes: Uint8Array): Promise<ZipContext> {
  let zipFiles: Map<string, Uint8Array>;
  try {
    zipFiles = (await unpackZip(bytes)).files;
  } catch (error) {
    // a crossed limit stops the drop here; a zip that will not open is validation's finding, in its own words
    if (error instanceof InputLimitError) throw error;
    return {};
  }
  try {
    const name = zipFiles.has("wearable.json") ? "wearable.json" : "emote.json";
    const bytes = zipFiles.get(name);
    if (bytes) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { category?: string; data?: { category?: string; hides?: string[] } };
      return { zipFiles, zipCategory: parsed.data?.category ?? parsed.category, zipHides: parsed.data?.hides, zipMetadata: parsed, zipMetadataSource: name };
    }
  } catch {
    // Validation reports malformed packages; display hints remain optional.
  }
  return { zipFiles };
}

export const isGlb = (bytes: Uint8Array): boolean => bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
export const isPng = (bytes: Uint8Array): boolean => bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

export function itemBytes(item: Loaded): number {
  return (item.bytes?.length ?? 0) + [...(item.files?.values() ?? [])].reduce((total, file) => total + file.length, 0);
}

/** "3.2 MB" / "640 KB": the size a creator sees next to the file name. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function inputKind(item: Loaded): string {
  if (item.files) return "published item";
  if (item.isBareGlb) return "GLB upload";
  return item.name.endsWith(".zip") ? "zip package" : "file";
}
