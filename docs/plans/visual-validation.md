> **Status.** Proposed. V-05 as built is described in [../visual-validation.md](../visual-validation.md); nothing else here is implemented (production policy, aggregation, worker, V-01..V-04/V-06/V-07 recipes).

# Visual validation implementation plan

Implementation is on `main`. After the local renderer test, the next requested iteration implements `thumbnail-honesty` with capture reuse, optional renderer/Pi adapters, and a local review runner. See the [runnable API](../../README.md#thumbnail-honesty-v-05). Full renderer acceptance, production policy profiles, the remaining visual rules and backend/UI remain pending; the increments below still describe that broader work. Production runs visuals only after complete code validation passes. Clipping starts in shadow mode until intentional skin exposure is distinguished from defects. Standalone visual rules remain independently callable.

The V-05 iteration uses twelve wearable frames at two body shapes (front/side/rear, worn and isolated), or twelve emote frames, plus the thumbnail. A front/side-only live test confused rear thumbnail artwork with the front; rear views and an explicit corresponding-side instruction address that fixture. Frames are sent individually until contact-sheet legibility is measured. Its implemented settings live under `rendering.thumbnailHonesty` and `ai.thumbnailHonesty`; the shared multi-rule recipes and budgets below remain proposed.

This introduces the project's first backend, server-held OAuth credential, uploaded rendering workload, and per-item AI consumption. Keep the current Cloudflare site static; candidate deployment is a Node API plus [Docker background worker on Render](https://render.com/docs/background-workers), with durable job/evidence storage and [persistent OAuth storage](https://render.com/docs/disks). Container feasibility and deployment sizing are decided in increment 0; no infrastructure is provisioned by this plan.

## One API and registry

Use the existing `validate` and `registry`. Add seven ordinary checks in group `rendering`; their `run(ctx)` receives injected services through `Options.services` and `CheckContext.services`. `/rendering` and `/ai` export optional adapters, not another validator API. Core defaults stay code-only; adapter imports never enter the root dependency graph. Replace the current rendering-group rejection with capability checks for selected rules.

Proposed usage:

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";
import { createRenderer } from "@dcl-regenesislabs/wearable-validator/rendering";
import { createPiReviewer } from "@dcl-regenesislabs/wearable-validator/ai";

await validate(input, {
  checks: ["clipping"],
  captures: suppliedCaptures,
  profile: submissionProfile,
  signal,
  services: { renderer: createRenderer(config), reviewer: createPiReviewer(aiConfig), captureStore }
});
```

Complete supplied evidence needs no renderer. Otherwise the configured adapter takes missing images automatically. No renderer plus missing images is `skipped`, with an actionable reason. Deterministic checks never initialize OAuth. Every new rule enters `explanations.ts`, `fixes.ts`, `details.ts`, and `docs-links.ts`, so existing registry-completeness tests include it. Return generated/reused evidence as `Result.captures` for later calls; UI formatting stays in the web app. Pin `playwright-core` and `@earendil-works/pi-ai` as optional peers, installed directly by the worker. Increment 1 tests the packed package with and without those peers; root imports remain usable without either.

| Check | Rule | Evidence and evaluator |
| --- | --- | --- |
| `render-valid` | V-01 | Load diagnostics and subject/baseline views; deterministic |
| `clipping` | V-02 | Worn normal/chroma views, poses/outfits; pixels plus AI, initially warnings |
| `skinning-quality` | V-03 | Animated joint/extreme-pose views; AI |
| `texture-integrity` | V-04 | Normal/close views and diagnostics; AI |
| `thumbnail-honesty` | V-05 | Thumbnail and clean item views; AI |
| `scale-sanity` | V-06 | Known framing and avatar reference; AI |
| `emote-visual-quality` | V-07 | Timed front/side frames, ground/rest references; AI |

Put per-rule prompt text and response schemas in `src/prompts.ts`, keyed by check name. Each entry has an integer `version`; prompt/schema changes increment it. Tests require entries exactly for AI-backed rules. Record prompt digest/version, package/manifest version, model snapshot and settings with each evaluation. Pin Pi's tested package family; server OAuth uses its persistent login/refresh implementation, with no API-key fallback or agent tools.

## Results and production policy

Add `CheckExecution { status, coverage, findings, reason? }`; `run` accepts that result or legacy `Finding[]`, normalized by the runner. Keep `CheckStatus` unchanged: complete/clean → `passed`; verified deterministic violation → `failed`; subjective finding → `warning`; missing prerequisite or unscheduled work → `skipped`; renderer/auth/model failure, refusal or malformed output → `errored`. Add `CheckResult.coverage: complete | missing | not-applicable`; record genuine inapplicability explicitly and exclude it from problem counts. Add typed finding evidence and `Options.signal`; the [contracts](visual-validation-contracts.md#check-execution-and-returned-evidence) define legacy normalization and result consistency checks. Missing required components cannot turn a mixed pixel/AI check green.

Export pure `evaluateValidation(results, { expectedIdentity, profile, stage })`. Every result carries actual input/context digest, validator/manifest versions and profile digest; mismatches return `incomplete` before aggregation. With matching identity, return blocking deterministic `failed`, then required-coverage `incomplete`, then unresolved `review-required`, otherwise `passed`. Profiles and applicability/context requirements are versioned in the manifest. Ordinary complete code warnings can pass the code stage; missing-context warnings cannot. The worker calls this function after code checks and again after visuals; it owns scheduling, not rule policy. Individual/subset runs retain `passed: null`. Manifest enforcement is explicit: `shadow` records findings without changing eligibility, `advisory` allows complete warnings, `review` requests human resolution, and `block` permits deterministic rejection. Clipping starts as shadow, including its incomplete/error outcomes.

A production code failure/incomplete decision makes zero renderer/AI calls. Run all code checks to collect findings. After eligibility, run deterministic image checks before AI, stopping later AI after a confirmed blocking failure and recording skipped work. Return one durable job report; retries update it. Validate actual pre-publication Builder context so unavailable future IDs do not create an impossible gate.

## Capture reuse

Resolve each selected rule's required views in order: supplied evidence → cache → render missing. Compute the union across selected checks and deduplicate simultaneous requests. Serialize camera/pose/skin-color changes inside a renderer session; isolate sessions across concurrent items. Cancellation, timeout and memory limits must clean up the browser process.

A capture key includes actual model/texture digests, representation and hide/replace settings, body shape, avatar/outfit/animation versions, renderer build, camera, pose/time, lighting, dimensions, pass and recipe version. Store image digest, coverage, load diagnostics and provenance. Production accepts trusted captures; a bare screenshot cannot prove the required view. Reuse compatible subsets and regenerate stale/missing images. Prompt/model/text-only changes invalidate evaluations, not unchanged captures. Persist individual frames and contact sheets with findings referencing capture IDs and optional image regions. The [recipe table](visual-validation-contracts.md#capture-recipes) specifies each rule’s views, animation times, pinned asset requirements, and sheet layout.

## Manifest and AI budget

Add these proposed keys under `src/manifest/manifest.json`; values are initial capture/budget settings, not proven detection thresholds:

| Keys | Initial values / decision gate |
| --- | --- |
| `rendering.capture.turntableSteps`, `elevationDegrees` | 8, [-30, +30]; angles/poses/assets fixed in the recipe table |
| `rendering.capture.emoteSamples`, `emoteViewNames` | 12, front/side |
| `rendering.capture.outfitCount`, `poseFractions`, `poseNames` | 3; [0.25, 0.5, 0.75]; six named clips in the recipe table |
| `rendering.capture.recipeVersion`, `sourceImageSizePx`, `sheetSizePx`, `sheetRows`, `sheetColumns` | 1; 1024; 1024; 2; 2 |
| `rendering.capture.maxImagesPerReview`, `rendering.limits.maxFramesPerItem` | 64, 256; no silent truncation |
| `rendering.limits.timeoutMs`, `memoryBytes` | Set from increment 0 before renderer ships |
| `ai.limits.callsPerItem`, `attemptsPerCheck`, `concurrency` | 6, 1, 1 |
| `ai.limits.inputTokensPerItem`, `outputTokensPerCheck` | 200,000; 1,000; include cache-read/write tokens in capacity accounting |
| `ai.cache.mode`, `ttlSeconds` | Optional prefix caching; 300 seconds; model/profile configuration frozen per run |
| `rendering.clipping.*`, `rendering.renderValid.*`, `validation.profiles.*` | Detector thresholds/coverage and enforcement established with local fixtures; clipping stays shadow |

Initial model baseline: Claude Sonnet 4.5 snapshot `claude-sonnet-4-5-20250929`, subject to the OAuth image smoke test. The two-representation wearable recipe uses at most 220 raw captures and 81 image submissions across five AI rules after 2×2 packing. With 1,000 prompt and output tokens/call, the [image-token estimate](https://platform.claude.com/docs/en/build-with-claude/vision) and [Sonnet rates](https://platform.claude.com/docs/en/about-claude/pricing) give approximately 118k input + 5k output tokens, or **$0.43/item API-equivalent without caching**. Hosting is extra; this is not an OAuth subscription invoice or measured accuracy claim. Validate usage and sheet legibility in increment 3.

Optional [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): keep the shared system text and identical ordered images before a cache breakpoint, and put rule instructions/schema after it; eligible Sonnet cache reads cost 0.1× input while the initial five-minute write costs 1.25×. Measure uncached/cold/warm costs through Pi/OAuth in increment 3, including prefix changes and expiry. Share prefixes where evidence overlaps; do not send every rule unrelated images just to obtain hits. Keep per-rule outputs independent, count full context against budgets, and require no cache hit for correctness.

## Sequence, owners and exit criteria

Estimates are engineering days for one implementer, excluding infrastructure/auth delays. Use local fixtures and manual review during development; curator availability is not a prerequisite. Begin with increment 0.

At each checkpoint, review the runnable change, captured evidence/tests, remaining gaps and the proposed next increment. Do not start a later increment while its prerequisite renderer capability is unresolved. The first checkpoint is the Unity camera/item-only gap documented in the experiment report; resolve that before the remaining increment 0 fixtures and Linux smoke, then review again before increment 1.

| Increment | Estimate | Deliverable and exit criteria |
| --- | --- | --- |
| 0. Renderer experiment | 2 days | Reuse the official wearable-preview `postMessage` blob protocol from [preview.tsx](../../packages/debug-ui/src/preview.tsx) in headless Chromium. Day 1: test paused frame-accurate `goTo`, chroma skin, camera, item-alone/outfit modes, distinct male/female files, and hide/replace behavior. Reuse the protocol, not the UI helper’s fabricated shared representation; use the [fixture matrix](visual-validation-contracts.md#increment-0-renderer-fixtures). Day 2: Linux/Render-container smoke, failure cleanup and latency/memory. Resolve and pin the actual previewer/engine builds: today's URL floats; its 2.19.0 comment is not a pin. Stop and choose Bevy/upstream work if a required capability fails. No production abstractions yet. |
| 1. Registry/API/policy | 2–3 days | Execution-result migration, service injection, identity-bound aggregate, shadow policy, and clean packed-package Node/browser tests. Prove independent selection, mixed-version rejection and zero costly calls on rejected code input. |
| 2. Captures and V-01 | 3–4 days | Real adapter/store and `render-valid`. Test full/partial/stale/corrupt images, shared requests and standalone auto-capture. Missing subject fails; dark valid item and renderer outage are distinguished. |
| 3. Pi and V-05 | 2–3 days | OAuth and `thumbnail-honesty`; one real image review plus refusal/auth/schema/error tests. Validate recipe sheet legibility and measure input/output/cache-read/cache-write usage, uncached/cold/warm cost, changed-prefix misses and expiry. Revise budgets before claiming complete coverage. |
| 4. Remaining visual rules | 5–8 days | Separate V-02/03/04/06/07 fixtures and evaluations; labeled cutouts, clipping, deformation, texture, scale and grounding cases. Use locally labeled fixtures and inspect disagreements; keep clipping and AI findings advisory. |
| 5. Backend/UI and shadow trial | 4–6 days + 1–2 calendar weeks observation | API/worker, durable jobs/evidence, consolidated UI report. Enforce budgets, cancellation and non-spamming retries. Compare results against local labels; production severity promotion is a later decision with human review evidence. |

Total: **18–26 engineering days**, plus observation; failed renderer feasibility adds a separately estimated fallback. F-03/IP, vision policy, catalog similarity and notifications are later scope.

## Decisions to close

| Decision | Proposed choice | Owner / deadline |
| --- | --- | --- |
| Renderer and host | Existing official preview protocol; Render Linux container candidate | Implementer records pinned build and feasibility at end of increment 0; project owner confirms hosting before backend work |
| Model, OAuth and spend | Pi adapter + Sonnet 4.5 baseline; budget above | Project owner supplies authorized server OAuth; implementer proves image request and records cost before increment 3 |
| Local evaluation and rollout | Locally labeled fixtures and saved evidence; clipping stays advisory | Implementer starts local evaluation in increment 2 and expands it in increment 4; production enforcement calibration follows local iteration |

References: [Notion RFC — Wearable & Emote Validator](https://app.notion.com/p/RFC-Wearable-Emote-Validator-3cd5f96e0b70806ea3f5e9f1787a9bef) and the more detailed [public Validator Rule Book](https://claude.ai/code/artifact/29e6586c-1da1-4eb1-992b-25c562ce0b2b). This plan incorporates the agreed changes: code-first production gating, independent AI rules, and advisory clipping during local iteration.
