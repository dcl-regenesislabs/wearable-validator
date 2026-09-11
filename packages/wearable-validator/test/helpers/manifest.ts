export function wearableManifest(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Test Wearable",
    description: "synthetic",
    rarity: "common",
    data: {
      category: "hat",
      tags: ["test"],
      representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"] }],
      ...dataOverrides
    },
    ...overrides
  };
}
