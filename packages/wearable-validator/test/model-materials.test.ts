import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode as encodeJpeg } from "jpeg-js";
import { validate } from "../src/index.js";
import { png16Bytes, pngBytes, syntheticGlb, syntheticZip } from "./helpers/synthetic.js";
import type { Finding } from "../src/types.js";

function only(findings: Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

describe("texture-count (M-02)", () => {
  it("errors when unique texture images exceed the default limit", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      extraMaterialDefs: [
        { name: "Second_MAT", textures: [{ size: 32 }] },
        { name: "Third_MAT", textures: [{ size: 16 }] }
      ]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-count"] });
    const findings = only(result.findings, "texture-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 3);
    assert.equal(findings[0].limit, 2);
    assert.equal(findings[0].where, "model.glb");
  });

  it("excludes AvatarSkin_MAT textures and applies the skin limit", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      extraMaterialDefs: [
        { name: "AvatarSkin_MAT", textures: [{ size: 32 }, { slot: "emissive", size: 16 }] },
        { name: "Detail_MAT", textures: [{ size: 8 }] }
      ]
    });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["texture-count"] });
    assert.equal(only(result.findings, "texture-count").length, 0);
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["texture-count"] });
    assert.equal(result.checks.length, 0);
    assert.equal(result.findings.length, 0);
  });
});

describe("texture-size (M-03)", () => {
  it("errors on textures over 512 on either axis", async () => {
    const glb = await syntheticGlb({ texture: { size: 1024 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const findings = only(result.findings, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "1024×1024");
  });

  it("errors on non-square textures", async () => {
    const glb = await syntheticGlb({ texture: { size: 512, nonSquare: true } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const findings = only(result.findings, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /square/);
  });

  it("warns on square non-power-of-two textures", async () => {
    const glb = await syntheticGlb({ texture: { size: 300 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    const findings = only(result.findings, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /power of two/);
  });

  it("passes a 512×512 texture", async () => {
    const glb = await syntheticGlb({ texture: { size: 512 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-size"] });
    assert.equal(only(result.findings, "texture-size").length, 0);
  });

  it("facial features over 256 are errors", async () => {
    const result = await validate(pngBytes(512, 512), { category: "eyes", checks: ["texture-size"] });
    const findings = only(result.findings, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, "256×256");
  });

  it("facial features without alpha are errors", async () => {
    const result = await validate(pngBytes(256, 256, true, 3), { category: "mouth", checks: ["texture-size"] });
    const findings = only(result.findings, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /alpha/);
  });

  it("warns once with category-unknown on a bare GLB without a hint", async () => {
    const glb = await syntheticGlb({ texture: { size: 1024 } });
    const result = await validate(glb, { checks: ["texture-size"] });
    const findings = only(result.findings, "texture-size");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].data?.reason, "category-unknown");
  });
});

describe("texture-format (M-04)", () => {
  it("errors on 16-bit PNGs", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: png16Bytes(64, 64), name: "deep" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-format"] });
    const findings = only(result.findings, "texture-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "16-bit");
  });

  it("errors on non-PNG/JPEG images", async () => {
    const glb = await syntheticGlb({
      textureImages: [{ bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), mimeType: "image/webp", name: "webp" }]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-format"] });
    const findings = only(result.findings, "texture-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /PNG or JPEG/);
  });

  it("passes 8-bit PNG and JPEG textures", async () => {
    const jpeg = encodeJpeg({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(128) }, 90).data;
    const glb = await syntheticGlb({
      texture: { size: 64 },
      textureImages: [{ slot: "emissive", bytes: new Uint8Array(jpeg), mimeType: "image/jpeg", name: "glow" }]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-format"] });
    assert.equal(only(result.findings, "texture-format").length, 0);
  });
});

describe("texture-maps (M-05)", () => {
  it("errors for each forbidden map, naming it", async () => {
    const glb = await syntheticGlb({
      texture: { size: 64 },
      textureImages: [
        { slot: "normal", size: 32 },
        { slot: "metallicRoughness", size: 16 },
        { slot: "occlusion", size: 8 }
      ]
    });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-maps"] });
    const findings = only(result.findings, "texture-maps");
    assert.equal(findings.length, 3);
    for (const f of findings) assert.equal(f.severity, "error");
    assert.deepEqual(
      findings.map((f) => f.data?.map).sort(),
      ["metallicRoughnessTexture", "normalTexture", "occlusionTexture"]
    );
  });

  it("passes base color + emissive", async () => {
    const glb = await syntheticGlb({ texture: { size: 64 }, textureImages: [{ slot: "emissive", size: 32 }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["texture-maps"] });
    assert.equal(only(result.findings, "texture-maps").length, 0);
  });
});

describe("material-count (M-06)", () => {
  it("errors above the default limit", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "Third_MAT" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
    const findings = only(result.findings, "material-count");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, 3);
    assert.equal(findings[0].limit, 2);
  });

  it("excludes AvatarSkin_MAT from the count", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "Second_MAT" }, { name: "AvatarSkin_MAT" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-count"] });
    assert.equal(only(result.findings, "material-count").length, 0);
  });

  it("allows 5 materials for skins", async () => {
    const glb = await syntheticGlb({
      extraMaterialDefs: [{ name: "M2" }, { name: "M3" }, { name: "M4" }, { name: "M5" }]
    });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-count"] });
    assert.equal(only(result.findings, "material-count").length, 0);
  });
});

describe("material-names (M-07)", () => {
  it("warns when a skin item has no AvatarSkin_MAT material", async () => {
    const result = await validate(await syntheticZip({ category: "skin" }), { checks: ["material-names"] });
    const findings = only(result.findings, "material-names");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /AvatarSkin_MAT/);
  });

  it("passes a skin item that includes AvatarSkin_MAT", async () => {
    const glb = await syntheticGlb({ extraMaterialDefs: [{ name: "AvatarSkin_MAT" }] });
    const result = await validate(await syntheticZip({ glb, category: "skin" }), { checks: ["material-names"] });
    assert.equal(only(result.findings, "material-names").length, 0);
  });

  it("errors on reserved facial tokens in mesh names of non-facial items", async () => {
    const glb = await syntheticGlb({ meshName: "cube_Eyes" });
    const result = await validate(await syntheticZip({ glb }), { checks: ["material-names"] });
    const findings = only(result.findings, "material-names");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].data?.pattern, "_eyes");
  });

  it("passes a plain mesh name", async () => {
    const result = await validate(await syntheticZip(), { checks: ["material-names"] });
    assert.equal(only(result.findings, "material-names").length, 0);
  });
});
