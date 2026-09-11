import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pngBytes, syntheticGlb, syntheticZip } from "../../packages/wearable-validator/test/helpers/synthetic.js";
import { digest } from "../../packages/wearable-validator/src/logic/captures.js";
import type { CaptureRecord, Result } from "../../packages/wearable-validator/src/types.js";
import type { ReviewRequest, ReviewResult } from "../../packages/wearable-validator/src/types.js";
import { dryRunReviewer, fileCredentials, readRun, recordingReviewer, replayReviewer, writeRun } from "../src/visual-review.js";

function reviewRequest(): ReviewRequest {
  return {
    check: "thumbnail-honesty",
    prompt: { version: 4, system: "System text.", instructions: "Instructions text.", schema: { type: "object" } },
    promptDigest: "digest-current",
    images: [
      { id: "BaseMale-avatar-000", label: "BaseMale: avatar, azimuth 0 degrees", bytes: pngBytes(4, 4), mimeType: "image/png" },
      { id: "thumbnail", label: "Original item thumbnail", bytes: pngBytes(4, 4, true), mimeType: "image/png" }
    ]
  };
}

describe("code gate", () => {
  it("stops on code failures before opening renderer binaries or OAuth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-gate-"));
    try {
      const file = join(directory, "invalid.zip");
      await writeFile(file, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }));
      const script = resolve(import.meta.dirname, "../src/visual-review.ts");
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--import", "tsx", script, file,
          "--auth", join(directory, "missing-session.json"),
          "--renderer-build", join(directory, "missing-build")
        ]),
        (error) => {
          assert.ok(error && typeof error === "object" && "stdout" in error && "stderr" in error);
          assert.equal(error.stderr, "");
          const output = JSON.parse(String(error.stdout));
          assert.equal(output.stage, "code");
          assert.equal(output.result.passed, false);
          assert.ok(output.result.findings.some((finding: { check: string }) => finding.check === "triangle-count"));
          return true;
        }
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("fileCredentials", () => {
  it("serializes concurrent refreshes and preserves other keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-auth-"));
    const path = join(directory, "session.json");
    try {
      const original = {
        anthropic: { type: "oauth", access: "dummy", refresh: "dummy", expires: 0 },
        other: { keep: true }
      };
      await writeFile(path, JSON.stringify(original));
      const first = fileCredentials(path);
      const second = fileCredentials(path);
      await Promise.all(
        [first, second].map((store) =>
          store.modify("anthropic", async (current) => {
            assert.equal(current?.type, "oauth");
            if (current?.type !== "oauth") throw new Error("Missing test credential");
            return { ...current, expires: current.expires + 1 };
          })
        )
      );
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.equal(saved.anthropic.expires, 2);
      assert.deepEqual(saved.other, original.other);
      await assert.rejects(first.modify("anthropic", async () => ({ type: "api_key", key: "dummy" })), /Only OAuth/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses environment files", () => {
    assert.throws(() => fileCredentials(join(tmpdir(), ".env")), /environment file/);
    assert.throws(() => fileCredentials(join(tmpdir(), ".env.local")), /environment file/);
  });
});

describe("run folder", () => {
  it("writeRun → readRun round-trips captures byte-for-byte", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-run-"));
    try {
      const captures: CaptureRecord[] = [];
      for (const [id, azimuthDegrees] of [["BaseMale-avatar-000", 0], ["BaseMale-avatar-090", 90]] as const) {
        const bytes = pngBytes(8, 8, azimuthDegrees === 90);
        captures.push({
          request: {
            id, key: `key-${id}`, inputDigest: "input", rendererBuild: "build", recipeVersion: 1,
            bodyShape: "urn:decentraland:off-chain:base-avatars:BaseMale", mainFile: "model.glb",
            view: "avatar", azimuthDegrees, size: 8
          },
          bytes, sha256: await digest(bytes), width: 8, height: 8
        });
      }
      const result: Result = {
        passed: null,
        checks: [{ check: "thumbnail-honesty", group: "rendering", status: "skipped", coverage: "missing", skipReason: "Configure services.reviewer." }],
        findings: [],
        captures,
        summary: { errors: 0, warnings: 0, checked: 0, skipped: 1 }
      };
      const thumbnail = pngBytes(4, 4);
      const index = await writeRun(directory, result, thumbnail);
      assert.equal(index, join(directory, "index.html"));

      const restored = await readRun(directory);
      assert.equal(restored.length, 2);
      for (const [i, capture] of restored.entries()) {
        assert.deepEqual(capture.request, captures[i].request);
        assert.equal(capture.sha256, captures[i].sha256);
        assert.equal(capture.width, 8);
        assert.equal(capture.height, 8);
        assert.equal(Buffer.compare(Buffer.from(capture.bytes), Buffer.from(captures[i].bytes)), 0);
      }

      const serialized = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
      assert.deepEqual(serialized.captures.map((c: { file: string }) => c.file), ["captures/BaseMale-avatar-000.png", "captures/BaseMale-avatar-090.png"]);
      assert.ok(serialized.captures.every((c: object) => !("bytes" in c)));
      const list = JSON.parse(await readFile(join(directory, "captures", "captures.json"), "utf8"));
      assert.deepEqual(Object.keys(list[0]).sort(), ["file", "height", "request", "sha256", "width"]);
      assert.equal(Buffer.compare(await readFile(join(directory, "thumbnail.png")), Buffer.from(thumbnail)), 0);
      const finding = JSON.parse(await readFile(join(directory, "thumbnail-honesty", "4-finding.json"), "utf8"));
      assert.equal(finding.check.check, "thumbnail-honesty");
      assert.deepEqual(finding.findings, []);
      const html = await readFile(index, "utf8");
      assert.ok(html.includes('id="BaseMale-avatar-090"') && html.includes("thumbnail.png"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records the prompt and context before the call and the answer after it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-tap-"));
    try {
      const folder = join(directory, "thumbnail-honesty");
      let promptExistedDuringCall = false;
      const inner = {
        async review(): Promise<ReviewResult> {
          promptExistedDuringCall = await readFile(join(folder, "1-prompt.md"), "utf8").then(() => true, () => false);
          return { ok: true, answer: { verdict: "matches" }, metadata: { provider: "test", model: "fake", promptVersion: 4, promptDigest: "digest-current" } };
        }
      };
      const result = await recordingReviewer(inner, directory, "thumbnail-honesty").review(reviewRequest());
      assert.equal(result.ok, true);
      assert.equal(promptExistedDuringCall, true);
      const prompt = await readFile(join(folder, "1-prompt.md"), "utf8");
      assert.ok(prompt.startsWith("# thumbnail-honesty · prompt v4 · digest digest-current\n## System\nSystem text."));
      assert.ok(prompt.includes("1. `Image ID: BaseMale-avatar-000` — BaseMale: avatar, azimuth 0 degrees — ![](../captures/BaseMale-avatar-000.png)"));
      assert.ok(prompt.includes("2. `Image ID: thumbnail` — Original item thumbnail — ![](../thumbnail.png)"));
      const context = JSON.parse(await readFile(join(folder, "2-context.json"), "utf8"));
      assert.equal(context.systemPrompt, "System text.");
      const images = context.messages[0].content.filter((block: { type: string }) => block.type === "image");
      assert.deepEqual(images.map((block: { id: string; file: string }) => [block.id, block.file]), [["BaseMale-avatar-000", "../captures/BaseMale-avatar-000.png"], ["thumbnail", "../thumbnail.png"]]);
      assert.ok(images.every((block: object) => !("data" in block) && "sha256" in block));
      assert.deepEqual(JSON.parse(await readFile(join(folder, "3-answer.json"), "utf8")), result);

      const dry = await dryRunReviewer().review(reviewRequest());
      assert.equal(dry.ok, false);
      assert.equal(dry.metadata.promptDigest, "digest-current");

      const stale = { ...reviewRequest(), promptDigest: "digest-next" };
      const replayed = await replayReviewer(join(folder, "3-answer.json")).review(stale);
      assert.equal(replayed.ok, true);
      assert.equal(replayed.metadata.promptDigest, "digest-next");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("readRun refuses a folder without captures.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-empty-"));
    try {
      await assert.rejects(readRun(directory), /ENOENT/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("run folder edge cases", () => {
  async function capture(id: string, key: string, azimuthDegrees: number): Promise<CaptureRecord> {
    const bytes = pngBytes(8, 8, azimuthDegrees === 90);
    return {
      request: {
        id, key, inputDigest: "input", rendererBuild: "build", recipeVersion: 1,
        bodyShape: "urn:decentraland:off-chain:base-avatars:BaseMale", mainFile: "model.glb",
        view: "avatar", azimuthDegrees, size: 8
      },
      bytes, sha256: await digest(bytes), width: 8, height: 8
    };
  }
  function resultWith(captures: CaptureRecord[]): Result {
    return {
      passed: null,
      checks: [{ check: "thumbnail-honesty", group: "rendering", status: "skipped", coverage: "missing", skipReason: "Configure services.reviewer." }],
      findings: [],
      captures,
      summary: { errors: 0, warnings: 0, checked: 0, skipped: 1 }
    };
  }

  it("readRun treats a deleted PNG as a missing view instead of failing the run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-missing-"));
    try {
      const captures = [await capture("BaseMale-avatar-000", "k0", 0), await capture("BaseMale-avatar-090", "k90", 90)];
      await writeRun(directory, resultWith(captures));
      await rm(join(directory, "captures", "BaseMale-avatar-090.png"));
      const restored = await readRun(directory);
      assert.deepEqual(restored.map((c) => c.request.id), ["BaseMale-avatar-000"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writeRun refuses two captures that would share one file name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visual-review-dup-"));
    try {
      const captures = [await capture("BaseMale-avatar-000", "k0", 0), await capture("BaseMale-avatar-000", "k0-other-build", 0)];
      await assert.rejects(writeRun(directory, resultWith(captures)), /share the id/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
