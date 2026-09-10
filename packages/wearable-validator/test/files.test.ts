import { describe, it } from "node:test";
import assert from "node:assert/strict";
import dclHashing from "@dcl/hashing";
import { validate, manifest } from "../src/index.js";
import { pngBytes, syntheticGlb, syntheticZip } from "./helpers/synthetic.js";
import type { Finding } from "../src/types.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function only(findings: Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

/** Re-encodes a GLB with its JSON chunk mutated (raw-JSON scenarios gltf-transform can't author). */
function patchGlbJson(glb: Uint8Array, mutate: (json: Record<string, unknown>) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
  mutate(json);
  let jsonBytes = enc(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad) {
    const padded = new Uint8Array(jsonBytes.length + pad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const rest = glb.subarray(20 + jsonLength);
  const out = new Uint8Array(12 + 8 + jsonBytes.length + rest.length);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true); // 'glTF'
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.length, true);
  outView.setUint32(12, jsonBytes.length, true);
  outView.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.length);
  return out;
}

function padBytes(bytes: Uint8Array, extra: number): Uint8Array {
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes);
  return out;
}

function wearableManifest(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe("file-format (S-01)", () => {
  it("errors on a .gltf model file", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.gltf", contents: ["model.gltf"] }] }),
      extraFiles: { "model.gltf": enc("{}") }
    });
    const findings = only((await validate(zip, { checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "model.gltf");
    assert.match(findings[0].message, /\.glb/);
  });

  it("errors on a .glb whose content is not GLB binary", async () => {
    const zip = await syntheticZip({ glb: enc("not a real model at all, sorry!!") });
    const findings = only((await validate(zip, { checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not GLB binary/);
  });

  it("errors on oversize facial-feature PNGs", async () => {
    const findings = only((await validate(pngBytes(300, 300), { category: "eyes", checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, "256×256");
  });

  it("passes a valid facial-feature PNG and a valid wearable zip", async () => {
    const facial = await validate(pngBytes(256, 256), { category: "mouth", checks: ["file-format"] });
    assert.equal(only(facial.findings, "file-format").length, 0);
    const zip = await validate(await syntheticZip(), { checks: ["file-format"] });
    assert.equal(only(zip.findings, "file-format").length, 0);
  });
});

describe("gltf-valid (S-02)", () => {
  it("errors on a truncated GLB (declared length mismatch)", async () => {
    const glb = await syntheticGlb();
    const zip = await syntheticZip({ glb: glb.subarray(0, glb.length - 16) });
    const findings = only((await validate(zip, { checks: ["gltf-valid"] })).findings, "gltf-valid");
    assert.ok(findings.length >= 1);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => /corrupt|truncated/.test(f.message)));
  });

  it("errors on an invalid JSON chunk and surfaces the parse error", async () => {
    // hand-built container: magic + version + a JSON chunk that is not JSON
    const jsonBytes = enc("{oops   ");
    const glb = new Uint8Array(12 + 8 + jsonBytes.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, jsonBytes.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(jsonBytes, 20);
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-valid"] })).findings, "gltf-valid");
    assert.ok(findings.length >= 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => /not valid JSON/.test(f.message)));
    assert.ok(findings.some((f) => /failed to parse/.test(f.message)));
  });

  it("passes a well-formed GLB and is not applicable to facial features", async () => {
    const zip = await validate(await syntheticZip(), { checks: ["gltf-valid"] });
    assert.equal(only(zip.findings, "gltf-valid").length, 0);
    const facial = await validate(pngBytes(256, 256), { category: "eyes", checks: ["gltf-valid"] });
    assert.equal(facial.checks.length, 0);
  });
});

describe("metadata (S-03)", () => {
  it("errors when no metadata is provided at all", async () => {
    const files = new Map<string, Uint8Array>([["model.glb", await syntheticGlb()]]);
    const findings = only((await validate({ files }, { checks: ["metadata"] })).findings, "metadata");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /No metadata/);
  });

  it("errors on an unparseable embedded manifest", async () => {
    const zip = await syntheticZip({ manifestRaw: "{not json" });
    const findings = only((await validate(zip, { checks: ["metadata"] })).findings, "metadata");
    assert.ok(findings.length >= 1);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => /not valid JSON/.test(f.message)));
  });

  it("warns when explicit metadata diverges from the embedded manifest", async () => {
    const files = new Map<string, Uint8Array>([
      ["model.glb", await syntheticGlb()],
      ["wearable.json", enc(JSON.stringify(wearableManifest({ name: "Zip Name" })))],
      ["thumbnail.png", pngBytes(256, 256)]
    ]);
    const metadata = {
      name: "Entity Name",
      description: "synthetic",
      rarity: "common",
      thumbnail: "thumbnail.png",
      data: { category: "hat", representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb"] }] }
    };
    const findings = only((await validate({ files, metadata }, { checks: ["metadata"] })).findings, "metadata");
    const warnings = findings.filter(f => f.severity === "warning");
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].data?.fields, ["name"]);
    assert.match(warnings[0].message, /embedded manifest/);
    assert.ok(findings.some(f => f.severity === "error" && f.where === "id"));
  });

  it("passes a builder zip with name and category", async () => {
    const result = await validate(await syntheticZip(), { checks: ["metadata"] });
    assert.equal(only(result.findings, "metadata").length, 0);
  });
});

describe("representations (S-04)", () => {
  it("errors when the item declares no representation", async () => {
    const zip = await syntheticZip({ manifest: wearableManifest({}, { representations: [] }) });
    const findings = only((await validate(zip, { checks: ["representations"] })).findings, "representations");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /at least one/);
  });

  it("errors when the mainFile is missing from the item", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "missing.glb", contents: ["missing.glb"] }] })
    });
    const findings = only((await validate(zip, { checks: ["representations"] })).findings, "representations");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /missing\.glb/);
  });

  it("errors when listed contents are missing", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.glb", contents: ["model.glb", "texture.png"] }] })
    });
    const findings = only((await validate(zip, { checks: ["representations"] })).findings, "representations");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /texture\.png/);
  });

  it("passes a complete representation", async () => {
    const result = await validate(await syntheticZip(), { checks: ["representations"] });
    assert.equal(only(result.findings, "representations").length, 0);
  });
});

describe("file-size (S-05)", () => {
  it("errors on total size and on the model-alone headroom", async () => {
    const glb = padBytes(await syntheticGlb(), 3_500_000);
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.equal(findings[0].limit, 3145728); // total, from the manifest
    assert.equal(findings[1].limit, 3145728 - 1048576); // model alone ≤ limit − headroom
    assert.equal(findings[1].where, "model.glb");
  });

  it("gives skins the skin budget", async () => {
    const glb = padBytes(await syntheticGlb(), 4_000_000);
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });

  it("applies the emote budget to emotes", async () => {
    const glb = padBytes(await syntheticGlb({ animation: { name: "Pose_Avatar", seconds: 2 } }), 3_500_000);
    const findings = only((await validate(await syntheticZip({ glb, kind: "emote" }), { checks: ["file-size"] })).findings, "file-size");
    assert.ok(findings.length >= 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, 3145728);
    assert.match(findings[0].message, /emote/);
  });

  it("warns once with category-unknown on a bare GLB without a hint", async () => {
    const findings = only((await validate(await syntheticGlb(), { checks: ["file-size"] })).findings, "file-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });

  it("passes a small wearable", async () => {
    const result = await validate(await syntheticZip(), { checks: ["file-size"] });
    assert.equal(only(result.findings, "file-size").length, 0);
  });
});

describe("thumbnail (S-06)", () => {
  it("errors when the thumbnail is missing", async () => {
    const zip = await syntheticZip({ thumbnail: null });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not found/);
  });

  it("errors when the thumbnail is not a PNG", async () => {
    const zip = await syntheticZip({ thumbnail: enc("JFIF-ish bytes") });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not a PNG/);
  });

  it("errors above the max dimension", async () => {
    const zip = await syntheticZip({ thumbnail: pngBytes(1030, 1030) });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.ok(findings.some((f) => f.severity === "error" && f.limit === "1024×1024"));
  });

  it("warns on a non-recommended size", async () => {
    const zip = await syntheticZip({ thumbnail: pngBytes(300, 300) });
    const findings = only((await validate(zip, { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].limit, "256×256");
  });

  it("warns when there is no alpha channel and when nothing is transparent", async () => {
    const noAlpha = only((await validate(await syntheticZip({ thumbnail: pngBytes(256, 256, true, 3) }), { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(noAlpha.length, 1);
    assert.equal(noAlpha[0].severity, "warning");
    assert.match(noAlpha[0].message, /alpha/);

    const opaque = only((await validate(await syntheticZip({ thumbnail: pngBytes(256, 256, true) }), { checks: ["thumbnail"] })).findings, "thumbnail");
    assert.equal(opaque.length, 1);
    assert.equal(opaque[0].severity, "warning");
    assert.match(opaque[0].message, /transparent/);
  });

  it("passes a transparent 256×256 PNG", async () => {
    const result = await validate(await syntheticZip(), { checks: ["thumbnail"] });
    assert.equal(only(result.findings, "thumbnail").length, 0);
  });
});

describe("name-description (S-07)", () => {
  it("errors on an over-long name", async () => {
    const zip = await syntheticZip({ manifest: wearableManifest({ name: "x".repeat(33) }) });
    const findings = only((await validate(zip, { checks: ["name-description"] })).findings, "name-description");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 33);
    assert.equal(findings[0].limit, 32);
  });

  it("errors on the forbidden character from the manifest", async () => {
    const zip = await syntheticZip({ manifest: wearableManifest({ name: "Hat: deluxe" }) });
    const findings = only((await validate(zip, { checks: ["name-description"] })).findings, "name-description");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].data?.character, ":");
  });

  it("errors on an over-long description and too many tags", async () => {
    const zip = await syntheticZip({
      manifest: wearableManifest({ description: "d".repeat(65) }, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })
    });
    const findings = only((await validate(zip, { checks: ["name-description"] })).findings, "name-description");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => f.where === "description" && f.limit === 64));
    assert.ok(findings.some((f) => f.where === "tags" && f.limit === 20));
  });

  it("passes compliant text", async () => {
    const result = await validate(await syntheticZip(), { checks: ["name-description"] });
    assert.equal(only(result.findings, "name-description").length, 0);
  });
});

describe("category (S-08)", () => {
  it("errors on an unknown category", async () => {
    const zip = await syntheticZip({ category: "backpack" });
    const findings = only((await validate(zip, { checks: ["category"] })).findings, "category");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "backpack");
  });

  it("errors on body_shape", async () => {
    const zip = await syntheticZip({ category: "body_shape" });
    const findings = only((await validate(zip, { checks: ["category"] })).findings, "category");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /body_shape/);
  });

  it("passes a known category", async () => {
    const result = await validate(await syntheticZip({ category: "hat" }), { checks: ["category"] });
    assert.equal(only(result.findings, "category").length, 0);
  });
});

describe("content-integrity (S-09)", () => {
  it("is not applicable without an entity content list", async () => {
    const result = await validate(await syntheticZip(), { checks: ["content-integrity"] });
    assert.equal(result.checks.length, 0);
    assert.equal(result.findings.length, 0);
  });

  it("errors on a hash mismatch", async () => {
    const glb = await syntheticGlb();
    const files = new Map([["model.glb", glb]]);
    const content = [{ file: "model.glb", hash: "bafybeigdyrztotallywrong" }];
    const findings = only((await validate({ files, content }, { checks: ["content-integrity"] })).findings, "content-integrity");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /does not match/);
  });

  it("errors both directions: declared-but-missing and present-but-undeclared", async () => {
    const glb = await syntheticGlb();
    const files = new Map([
      ["model.glb", glb],
      ["stray.png", pngBytes(8, 8)]
    ]);
    const content = [
      { file: "model.glb", hash: await dclHashing.hashV1(glb) },
      { file: "ghost.png", hash: "bafybeighost" }
    ];
    const findings = only((await validate({ files, content }, { checks: ["content-integrity"] })).findings, "content-integrity");
    assert.equal(findings.length, 2);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.ok(findings.some((f) => f.where === "ghost.png" && /missing/.test(f.message)));
    assert.ok(findings.some((f) => f.where === "stray.png" && /not declared/.test(f.message)));
  });

  it("passes when every hash matches in both directions", async () => {
    const glb = await syntheticGlb();
    const thumb = pngBytes(256, 256);
    const files = new Map([
      ["model.glb", glb],
      ["thumbnail.png", thumb]
    ]);
    const content = [
      { file: "model.glb", hash: await dclHashing.hashV1(glb) },
      { file: "thumbnail.png", hash: await dclHashing.hashV1(thumb) }
    ];
    const result = await validate({ files, content }, { checks: ["content-integrity"] });
    assert.equal(only(result.findings, "content-integrity").length, 0);
    assert.equal(result.checks[0]?.status, "passed");
  });
});

describe("gltf-hygiene (S-10)", () => {
  it("errors on cameras", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.cameras = [{ type: "perspective", perspective: { yfov: 1, znear: 0.1 } }];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /camera/);
  });

  it("errors on lights (KHR_lights_punctual)", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.extensionsUsed = ["KHR_lights_punctual"];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /lights/);
  });

  it("errors on required extensions outside the allowlist", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.extensionsUsed = ["EXT_not_supported_anywhere"];
      j.extensionsRequired = ["EXT_not_supported_anywhere"];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].data?.extension, "EXT_not_supported_anywhere");
  });

  it("warns on unknown used-but-not-required extensions", async () => {
    const glb = patchGlbJson(await syntheticGlb(), (j) => {
      j.extensionsUsed = ["EXT_totally_custom"];
    });
    const findings = only((await validate(await syntheticZip({ glb }), { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.extension, "EXT_totally_custom");
  });

  it("warns on a ±90°-X root rotation only when the heuristic is enabled (off by default)", async () => {
    const glb = await syntheticGlb({ rootRotation: [0.70710678, 0, 0, 0.70710678] });
    const zip = await syntheticZip({ glb });
    // Off by default — fired on virtually every committee-approved catalyst item.
    assert.equal(only((await validate(zip, { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene").length, 0);
    const gltfConfig = manifest.gltf as { zUpHeuristic?: boolean };
    gltfConfig.zUpHeuristic = true;
    try {
      const findings = only((await validate(zip, { checks: ["gltf-hygiene"] })).findings, "gltf-hygiene");
      assert.equal(findings.length, 1);
      assert.equal(findings[0].severity, "warning");
      assert.match(findings[0].message, /Z-up/);
    } finally {
      gltfConfig.zUpHeuristic = false;
    }
  });

  it("passes a clean allowlisted GLB", async () => {
    const result = await validate(await syntheticZip(), { checks: ["gltf-hygiene"] });
    assert.equal(only(result.findings, "gltf-hygiene").length, 0);
  });
});

describe("smart-wearable (S-11)", () => {
  it("is not applicable to a plain wearable with no empty files", async () => {
    const result = await validate(await syntheticZip(), { checks: ["smart-wearable"] });
    assert.equal(result.checks.length, 0);
  });

  it("reports stray 0-byte files even on non-smart items", async () => {
    const zip = await syntheticZip({ extraFiles: { "stray.txt": new Uint8Array(0) } });
    const findings = only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "stray.txt");
    assert.match(findings[0].message, /0-byte/);
  });

  it("errors when scene.json points at a missing bundle", async () => {
    const zip = await syntheticZip({ extraFiles: { "scene.json": enc(JSON.stringify({ main: "bin/game.js" })) } });
    const findings = only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /bin\/game\.js/);
  });

  it("warns on permissions outside the allowed set", async () => {
    const zip = await syntheticZip({
      extraFiles: {
        "scene.json": enc(JSON.stringify({ main: "game.js", requiredPermissions: ["ALLOW_EVERYTHING"] })),
        "game.js": enc("//bundle")
      }
    });
    const findings = only((await validate(zip, { checks: ["smart-wearable"] })).findings, "smart-wearable");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.permission, "ALLOW_EVERYTHING");
  });

  it("errors on a video over the size cap (size only, never decoded)", async () => {
    const videoLimit = 262144000; // manifest smartWearableVideoBytes
    const files = new Map<string, Uint8Array>([
      ["scene.json", enc(JSON.stringify({ main: "game.js" }))],
      ["game.js", enc("//bundle")],
      ["intro.mp4", new Uint8Array(videoLimit + 1)]
    ]);
    const findings = only(
      (await validate({ files }, { checks: ["smart-wearable"], maxInputBytes: 400 * 1024 * 1024 })).findings,
      "smart-wearable"
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "intro.mp4");
    assert.equal(findings[0].limit, videoLimit);
  });

  it("passes a complete smart wearable with allowed permissions", async () => {
    const zip = await syntheticZip({
      extraFiles: {
        "scene.json": enc(JSON.stringify({ main: "game.js", requiredPermissions: ["USE_FETCH"] })),
        "game.js": enc("//bundle")
      }
    });
    const result = await validate(zip, { checks: ["smart-wearable"] });
    assert.equal(only(result.findings, "smart-wearable").length, 0);
    assert.equal(result.checks[0]?.status, "passed");
  });
});
