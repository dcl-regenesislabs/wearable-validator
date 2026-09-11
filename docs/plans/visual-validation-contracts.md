> **Status.** Proposed. V-05 as built is described in [../visual-validation.md](../visual-validation.md); nothing else here is implemented (production policy, aggregation, worker, V-01..V-04/V-06/V-07 recipes).

# Visual validation contracts and fixtures

Implementation detail for the [plan](visual-validation.md). The [V-05 iteration](../../README.md#thumbnail-honesty-v-05) now implements `CheckExecution`, complete/missing coverage, service injection, reusable captures and optional renderer/Pi entries. Inapplicable legacy checks remain absent. Identity-bound production aggregation, policy profiles, shared recipes/contact sheets and the other visual checks below remain proposed.

## Check execution and returned evidence

Add `CheckExecution` to `types.ts` with `status: CheckStatus`, `coverage: complete | missing | not-applicable`, `findings: Finding[]`, and optional `reason`. Change `CheckDefinition.run` to return `Finding[] | CheckExecution`, synchronously or asynchronously. The runner normalizes legacy arrays to complete executions using their existing severity mapping. Exceptions become `errored/missing`; reviewer truncation or invalid response coverage is an execution error even if the returned JSON parses. A rule that cannot obtain required captures returns `skipped/missing`; it never returns an empty array as a substitute.

Add coverage to `CheckResult`, computed by the runner for missing-category and parse-error paths too. Inapplicability produces `skipped/not-applicable` with its reason. Exclude those rows from checked/skipped-problem counts and UI failure filters; update existing tests that expect inapplicable rows to be absent. Reject inconsistent executions, such as `passed/missing` or findings assigned to another check, as execution errors. Known violations can coexist with missing coverage; they must remain visible.

Add `Finding.evidence?: EvidenceRef[]`, where each reference contains a capture ID and optional normalized image region. Add `Result.captures: CaptureRecord[]`, populated by the shared resolver, so callers can pass those captures into another `validate` call without a persistent store. A capture record contains its request key, image digest, MIME/dimensions, bytes or a durable locator, view/pose/body-shape metadata, provenance, and relevant load diagnostics. Validate evidence IDs/regions and keep frame-to-contact-sheet tile mappings. Budgeted capture outputs and asynchronous store access must accept cancellation.

Standalone calls execute only selected rules; infrastructure helpers are shared dependencies. A missing AI component leaves a mixed rule incomplete even if its deterministic component succeeded. Add `Options.signal` and propagate it through the runner, resolver and reviewer.

## Input binding and aggregate policy

`Result.identity` contains `inputDigest`, `manifestVersion`, `validatorVersion`, and `profileDigest`. The input digest covers canonical paths and actual bytes, supplied metadata/content declarations, and effective type/category/body-shape hints. A full submission identity is distinct from the appearance-only capture key. Snapshot these inputs once; the worker uses the same snapshot for both stages.

Add `Options.profile`; it defaults to the existing code profile. A production worker supplies the same full-submission profile to both code and rendering stage calls. Selection changes which checks run, not the profile identity. `evaluateValidation(results, { expectedIdentity, profile, stage })` rejects mismatched identity/version/profile or conflicting duplicate check executions as `incomplete` before inspecting findings. Record normalized applicability context with the identity-bound result; the aggregate computes required checks from that context and the supplied profile, verifying the profile digest rather than trusting result coverage claims alone. Missing rows never count as passes. Subset and visual-only `Result.passed` remain `null`; core default behavior remains code-only. Test selection by check identities rather than the number of requested groups.

Per-check `validation.profiles.<name>.checks.<check>.enforcement` is `shadow | advisory | review | block`. Shadow executions are recorded but do not affect the production decision, including when they are incomplete. Advisory warnings do not require human review, but required advisory checks still need complete coverage. Review findings require human resolution; block mode can fail only for verified deterministic violations. Clipping initially uses shadow; AI-only rules cannot use block. Local shadow profiles are separate from future enforcement profiles; changing either changes the profile digest.

After identity validation, decision order is blocking deterministic failure, missing required non-shadow coverage, unresolved review findings, then passed. Human overrides, if later supported, must reference the exact identity/check; the initial implementation treats all review findings as unresolved. Core-stage ineligibility performs zero visual work. Standalone visual calls do not enforce the core-stage gate.

## Capture recipes

Store these definitions in `rendering.capture` in the manifest. Render only declared representations, preserving their distinct main files and effective hides/replaces. For bare models, require explicit shape hints rather than inventing production coverage.

| Recipe | Manifest-defined coverage per representation |
| --- | --- |
| `turntable` | Azimuths 0, 45, 90, 135, 180, 225, 270, 315 degrees at level elevation; front at elevations -30 and +30 degrees. Ten frames. |
| `motion` | Six pinned clips: idle, walk, run, jump, fist-pump, head-explode; fractions 0.25, 0.5, 0.75 of each clip duration, front and side. Thirty-six frames. |
| `outfits` | Three pinned category-compatible outfit definitions, front and side at rest. Six frames. Honor item hides/replaces when composing outfits. |
| `emote` | Twelve evenly spaced times including start/end, front and side. Pause before scrubbing; capture after verified pose readiness. Twenty-four frames. |
| `baseline` | Front and side of the same avatar/setup with the subject removed, plus load health diagnostics. |

`rendering.capture.assets` records actual asset path/digest/version for base avatars, clips and outfits; resolve them during increment 0 before finalizing recipe fixtures. Camera projection/distance/target, lighting/background, rest pose, skin color and readiness tolerance are named settings in the same recipe record, with values fixed by the experiment. Scale checks use a fixed avatar-relative camera and no automatic item resizing.

| Rule | Required recipe/pass |
| --- | --- |
| V-01 | Front/side subject and baseline, load diagnostics; works without AI. |
| V-02 | Wearable: normal and chroma turntables; normal and chroma motion; normal outfits. Emotes without a wearable subject are not applicable. |
| V-03 | Wearable: normal motion. Emote: its normal emote recipe. |
| V-04 | Wearable: normal worn and item-alone turntables. Emote: normal emote recipe. |
| V-05 | Wearable: front/side worn and item-alone views plus original thumbnail. Emote: front/side at start/middle/end plus thumbnail; no empty item-alone requirement for a prop-less emote. |
| V-06 | Wearable: fixed-camera front/side worn views. Emote: start front/side views with avatar/ground reference. |
| V-07 | Normal emote recipe and loop metadata; wearables are not applicable. |

Initial transport packs four 1024-square source frames into a labeled 2×2, 1024-square contact sheet; the original frames remain available. At two representations, V-02 requires 196 frames/49 sheets, V-03 72/18, V-04 40/10, V-05 eight frames/two sheets plus thumbnail, and V-06 four frames/one sheet. This is 81 image submissions across five wearable AI calls, with overlapping source frames rendered once. Including baselines, the initial wearable union has at most 220 raw frames. These are recipe counts, not timing measurements.

Use `maxImagesPerReview: 64`, `maxFramesPerItem: 256`, `sheetColumns: 2`, `sheetRows: 2`, `sheetSizePx: 1024`, and `sourceImageSizePx: 1024` in the manifest. Test contact-sheet legibility using the same labeled defects at native size and sheet size during increment 3. If resizing hides defects, revise sheet layout/resolution, recipe coverage and budgets together before claiming coverage complete; never silently truncate frames to meet a cap. Any additional crop must reference its source and consume the image budget.

## Increment 0 renderer fixtures

Reuse the `postMessage` protocol, not the current UI's simplified metadata builder: it selects the first representation, assigns it to both shapes, and supplies empty hides/replaces. Require fixtures with visibly different male/female models, a hidden/replaced body part, intentional cutouts, a dark valid item, an invalid model, a stalled render, and an emote with recognizable keyed poses. Prove item-alone mode and outfit composition as well as camera/chroma/scrubbing. Record expected-versus-captured results on the pinned build; a failed capability stops dependent work and triggers the fallback decision.

## Packaging and acceptance matrix

Use exact tested versions of `playwright-core` and `@earendil-works/pi-ai` as optional peers with `peerDependenciesMeta.optional: true`; install them as dev dependencies for repository checks and direct dependencies of the worker. Chromium is explicitly installed in the worker image. Root check wrappers use only injected interfaces. Optional adapter entrypoints may statically import their peers. Document installation before adapter import. Construction validates settings only; launch Chromium or resolve OAuth on the first operation that needs it, with no key fallback. Complete supplied captures must work even when no Chromium executable is installed.

Increment 1 runs `npm pack` and installs the tarball in clean Node/browser fixtures: root validation succeeds without either peer, the root browser bundle contains no server adapter/Pi/Chromium runtime, and adapter exports resolve with their documented peers. Increments 2 and 3 add runtime tests for the renderer/browser installation and reviewer/credential store respectively. Missing runtime configuration produces actionable errors on first use. Retain registry/source-link completeness tests for all seven rules.

| Regression | Required result |
| --- | --- |
| All/partial/stale supplied captures | Zero renders / only missing renders / only stale views replaced; returned captures reusable in a second standalone call |
| Concurrent identical capture requests | One render; no camera/skin state contamination |
| Model/prompt changes | Re-evaluate without rerendering compatible captures |
| Item or profile edited between stages | Aggregate incomplete; no mixed-version approval |
| Shadow clipping warning/error | Visible report, unchanged otherwise-complete production decision |
| Missing required capture/reviewer; refusal; timeout | Skipped/errored with missing coverage, never passed |
| Deterministic-only or failed-code production run | Zero OAuth/model calls |
| Prompt cache benchmark | Compare uncached, cold-write, warm-read, changed-rule-suffix, changed-prefix and expired-cache usage; no correctness dependency on a hit |

The Pi adapter may use its typed `onPayload` hook to position an explicit image-prefix breakpoint; default last-message caching alone does not establish cross-rule reuse. Inspect the outgoing block structure with dummy images, then measure real cache usage with the configured OAuth provider in increment 3. Keep the common system prefix stable and carry each rule's instructions/schema in the suffix; no previous rule answer is part of the next request.
