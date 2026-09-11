# @dcl-regenesislabs/wearable-validator

Validate Decentraland wearable/emote files and caller-supplied item metadata. Default runs select the 35 deterministic checks. Individual checks return `passed: null`.

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate({ files, metadata }, { checks: ["triangle-count"] });
```

The first visual check, `thumbnail-honesty` (V-05), uses the same API with injected `services.renderer` and `services.reviewer`. Pass a previous `result.captures` back as `captures` to reuse renders. Results carry `captures`, per-check `coverage` and `review` provenance (model, prompt version and digest, token usage). Visual discrepancies are advisory warnings; missing evidence, inconclusive answers and provider failures never pass.

Optional Node entries:

- `/rendering`: `await createRenderer({ buildDirectory })` — needs `playwright-core@1.63.0`, its full Chromium (`npx playwright-core install chromium --no-shell`) and a Unity Web build of unity-explorer PR #10053. Call `renderer.stop()` on shutdown.
- `/ai`: `createPiReviewer({ credentials })` — needs `@earendil-works/pi-ai@0.84.1` and a host-owned Pi `CredentialStore` holding an Anthropic OAuth session. One schema-constrained image request, no tools, no agent loop.

Root imports need neither. See the repository's [docs/visual-validation.md](https://github.com/dcl-regenesislabs/wearable-validator/blob/main/docs/visual-validation.md) for the run folder every review writes.
