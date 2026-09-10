import { importBytes } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// Keep the importer pinned to @dcl/hashing's UnixFS version so deployed CIDs stay identical.
export async function contentHash(bytes: Uint8Array, version: 0 | 1 = 1): Promise<string> {
  // Legacy Decentraland hashes wrap the whole-file SHA-256, without UnixFS chunking.
  if (version === 0) return CID.createV0(await sha256.digest(bytes)).toString();
  const discardBlocks = { put: async <T>(cid: T): Promise<T> => cid };
  const { cid } = await importBytes(bytes, discardBlocks, { cidVersion: 1, rawLeaves: true });
  return cid.toString();
}
