/**
 * Reviewer wrappers around the library's Reviewer contract: the setup-token credential store, the recording
 * wrapper that leaves prompt/context/answer in the run folder, the --no-ai dry run, the --answer replay and the
 * live wrapper that announces each model call on a run's event stream.
 * Previous hop: main.ts (server) and review.ts (CLI) compose them around createPiReviewer().
 * Next hop: validate() calls review(); runs.ts formats what lands on disk.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { Reviewer, ReviewResult } from "@dcl-regenesislabs/wearable-validator";
import { contextJson, promptMarkdown, readEvidenceFile } from "./runs.js";
import type { RunSink } from "./server.js";

// a `claude setup-token` (sk-ant-oat…) lives about a year and is itself the bearer, not a refresh token
const SETUP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export const DRY_RUN_REASON = "The model was not called (--no-ai).";

/** The only credential: a `claude setup-token` from the environment, seeded in memory as the access token so the SDK never tries to refresh it. */
export function tokenCredentials(token: string): CredentialStore {
  if (!token.startsWith("sk-ant-oat")) throw new Error("ANTHROPIC_OAUTH_SETUP_TOKEN must be a `claude setup-token` (sk-ant-oat…), not an API key.");
  let current: Credential | undefined = { type: "oauth", access: token, refresh: token, expires: Date.now() + SETUP_TOKEN_TTL_MS };
  return {
    async read(provider, options) {
      options?.signal?.throwIfAborted();
      return provider === "anthropic" ? current : undefined;
    },
    async list() {
      return current ? [{ providerId: "anthropic", type: "oauth" }] : [];
    },
    async modify(provider, fn) {
      if (provider !== "anthropic") throw new Error("This credential store supports Anthropic OAuth only.");
      const next = await fn(current);
      if (next && next.type !== "oauth") throw new Error("Only OAuth credentials can be stored here.");
      if (next) current = next;
      return next ?? current;
    },
    async delete(provider) {
      if (provider === "anthropic") current = undefined;
    }
  };
}

/** Writes <check>/1-prompt.md and 2-context.json BEFORE forwarding, 3-answer.json after — so --no-ai still leaves the prompt on disk. */
export function recordingReviewer(reviewer: Reviewer, dir: string): Reviewer {
  return {
    async review(request, signal) {
      const folder = join(dir, request.check);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "1-prompt.md"), promptMarkdown(request));
      await writeFile(join(folder, "2-context.json"), JSON.stringify(await contextJson(request), null, 2));
      const result = await reviewer.review(request, signal);
      await writeFile(join(folder, "3-answer.json"), JSON.stringify(result, null, 2));
      return result;
    }
  };
}

/** --no-ai: renders and records the prompt, never calls the model; the row becomes errored with this reason. */
export function dryRunReviewer(): Reviewer {
  return {
    async review(request) {
      return {
        ok: false,
        reason: DRY_RUN_REASON,
        metadata: { provider: "none", model: "none", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
      };
    }
  };
}

/** --from <run> --answer: replays each check's saved 3-answer.json through the checks with zero network. */
export function replayReviewer(runDir: string): Reviewer {
  return {
    async review(request) {
      const answerPath = join(runDir, request.check, "3-answer.json");
      const saved: unknown = JSON.parse((await readEvidenceFile(answerPath)).toString("utf8"));
      if (!saved || typeof saved !== "object" || typeof (saved as { ok?: unknown }).ok !== "boolean" || !("metadata" in saved)) {
        throw new Error(`${answerPath} is not a saved ReviewResult. Run npm run review with ANTHROPIC_OAUTH_SETUP_TOKEN set first.`);
      }
      const result = saved as ReviewResult;
      if (result.metadata.promptDigest !== request.promptDigest) {
        console.error(`Warning: ${answerPath} was produced for prompt digest ${result.metadata.promptDigest}, the current prompt is ${request.promptDigest}.`);
      }
      // echo the request's digest — the answer is replayed against this prompt on purpose
      const metadata = { ...result.metadata, promptVersion: request.prompt.version, promptDigest: request.promptDigest };
      return result.ok ? { ok: true, answer: result.answer, metadata } : { ok: false, reason: result.reason, metadata };
    }
  };
}

/** Announces the prompt before the model call and the answer after it, on top of the recording wrapper. */
export function liveReviewer(reviewer: Reviewer, run: RunSink): Reviewer {
  return {
    async review(request, signal) {
      const check = request.check;
      run.emit("review", {
        check,
        phase: "request",
        promptVersion: request.prompt.version,
        promptDigest: request.promptDigest,
        images: request.images.map((image) => ({ id: image.id, label: image.label })),
        promptUrl: `/api/runs/${run.id}/${check}/1-prompt.md`
      });
      const result = await reviewer.review(request, signal);
      run.emit("review", { check, phase: "answer", ...result });
      return result;
    }
  };
}
