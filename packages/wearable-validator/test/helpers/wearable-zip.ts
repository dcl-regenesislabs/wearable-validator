import { syntheticGlb, syntheticZip, type SyntheticOptions } from "./synthetic.js";

/** A hat wearable zip around a synthetic GLB; `data` merges into the manifest's data block. */
export async function wearableZip(glbOpts: SyntheticOptions = {}, data: Record<string, unknown> = {}): Promise<Uint8Array> {
  const glb = await syntheticGlb(glbOpts);
  return syntheticZip({
    glb,
    manifest: { name: "Test", description: "synthetic", rarity: "common", data: { category: "hat", ...data } }
  });
}
