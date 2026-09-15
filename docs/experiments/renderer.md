> **Status.** Phase-0 lab notebook, frozen, plus one later observation: item-only framing is not deterministic across runs (2026-09-11, three `visual:review` runs of `upper_body.zip` on the same PR #10053 build — worn views identical, isolated views differed in framing in two of three runs). Resolved 2026-09-15: loading item-alone views first in a session makes them repeatable (`sessionOrder` in adapters/rendering.ts). The probe now drives `packages/wearable-validator/src/adapters/rendering.ts`; its parameters live in `manifest.rendering.probe`. The live doc is [visual-validation.md](../visual-validation.md).

# Renderer experiment — first review checkpoint

The probe runs on `main`; production visual validation has not started. A local Unity build verifies camera controls and isolated local wearables. The subsequent [V-05 iteration](../visual-validation.md) adds experimental adapters and a local review runner. **Keep renderer acceptance open:** framing, the remaining fixture matrix and Linux measurements still need validation before production rollout.

## Reproduce

From the repository root:

```bash
npm install
npx playwright-core install chromium --no-shell
npm run renderer:probe -w wearable-validator-tools -- --gpu hardware
npm run renderer:probe -w wearable-validator-tools -- --gpu software
```

The command prints a unique directory under `tools/artifacts/`. Open `index.html` for captures and `report.json` for observations, timing, GPU identity, fixture hashes and downloaded asset digests. `events.json` contains the received protocol messages. Exit code 1 means feasibility remains incomplete. `observed` requires image inspection; it is never a passing validation check.

The experiment uses only bundled `upper_body.zip` and `emote.zip`, preserving their separate representation files and metadata. These are local-upload protocol fixtures, not published-item validation. Tooling tests cover preservation of representation contents/overrides, rejection of missing files/shapes, local build decompression and refusal to mix incomplete or ambiguous local binaries. Run `npm test -w wearable-validator-tools`.

For a local Unity build, add `--renderer-build /path/to/avatar-preview-renderer/Build`. The iframe wrapper remains pinned; the report identifies local binaries separately and records their decoded hashes. Loading the existing vendored binaries through this path reproduced the camera failure, establishing a baseline for testing renderer changes.

## Deployed 2.20.0 baseline

| Capability | Evidence / remaining limit |
| --- | --- |
| Official Unity renderer | Preview 2.20.0, with JS and Unity binaries verified against [the build lock](../../packages/wearable-validator/src/rendering-build.json). The usual website URL selects Babylon. Request Unity explicitly and verify the reported engine. |
| Local blob input | Requires `mode=builder`; the default profile mode loads an avatar while ignoring the uploaded item. The probe now uses Builder mode. |
| Headless capture | 1024×1024 PNGs work using Chromium 153.0.8010.12, Playwright 1.63.0, on this ARM Mac. Use [full headless Chromium](https://playwright.dev/docs/browsers#chromium-new-headless-mode); the separate headless shell produced WebGPU errors and screenshot timeouts. |
| Software WebGPU | Confirmed `architecture=swiftshader`, `isFallbackAdapter=true`. The final local run saved 11 captures in 47.3 seconds, including startup/downloads and deliberate waits. This is a smoke-run measurement, not a throughput estimate. |
| Representations / chroma | Inspected captures show the declared male/female shirts and green exposed skin. Fixture transport preserves hides/replaces, but their rendered behavior still needs dedicated fixtures. |
| Paused emote samples | At 25% and 75% of the clip, poses differ; holding a pose for one second and seeking back produce identical decoded pixels. This establishes repeatability on this sample, not frame-exact timing across emotes. |
| Camera | **Missing in the deployed build.** On the frozen emote, `scene.changeCameraPosition` returns success but the image stays identical. Idle movement can falsely appear to confirm the command, so the test first proves pose stability. |
| Item-only capture | **Missing in the deployed build.** In Builder mode, `type=wearable` still includes the avatar in `item-alone.png`. The bridge's item-only behavior needs support for local blobs. |
| Linux / hosting | Not run: Docker is unavailable in this environment. No Linux memory/latency or Render suitability claim follows from the Mac run. |

The runner separates ANGLE and WebGPU selection: software mode explicitly sets `--use-webgpu-adapter=swiftshader`, as used by [Chromium's WebGPU tests](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/web_tests/FlagSpecificConfig). Inspect `environment.webgpuAdapter` in the report rather than inferring WebGPU's backend from an ANGLE flag.

## Local renderer changes

[Unity renderer PR #10053](https://github.com/decentraland/unity-explorer/pull/10053) adds the missing camera receivers and Builder item-only view. It builds with Unity `6000.5.9f1` plus Web Build Support. The probe loads those binaries into the unchanged 2.20.0 iframe wrapper.

- Two Unity camera tests pass with the changes and fail against the original renderer code because its bridge methods are missing.
- Azimuth and elevation change the rendered view; held and repeated views have identical decoded pixels. Zoom reverses to identical pixels, and repeating an absolute pan target does not move it again.
- Inspected item-only captures exclude the separate avatar. Skin geometry included in the uploaded GLB remains part of the isolated item.
- Paused emote scrubbing still produces distinct, repeatable poses. An unsupported emote/item-only request reports an error, and the engine accepts the next valid local wearable.
- The pinned wrapper substitutes a generic error message and leaves its previous error overlay visible after the engine recovers. Its load handler needs to clear that UI state; this is recorded separately as `wrapper-error-reset`.
- Tilted views can crop emote props. Working camera controls do not establish a complete framing recipe or frame-exact animation timing.

The verified run produced 21 captures in 77.3 seconds, including deliberate waits. Each probe prints its own gitignored evidence directory; the report identifies local binary hashes, fixture hashes, observations and the capture gallery. Reuse the same local binaries with `--renderer-build`.

## Next iteration, after review

Clear the wrapper's stale error state and calibrate broader framing. Finish the distinct-color representation fixture, keyed-pose ground truth, hide/replace and outfit fixtures, cutout/dark/invalid inputs, Linux smoke and memory/latency measurements from the [phase 0 matrix](../plans/visual-validation-contracts.md#increment-0-renderer-fixtures). The V-05 adapter uses a pinned embedded pose because the renderer's ordinary idle animation ignores the emote pause command; repeated decoded pixels establish readiness.

V-05 provides the next local review checkpoint. Production policy aggregation, V-01, other visual rules and backend/UI remain separate deliverables.
