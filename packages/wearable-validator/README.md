# @dcl-regenesislabs/wearable-validator

Validate Decentraland wearable/emote files and caller-supplied item metadata. Default runs select the 35 deterministic checks. Individual checks return `passed: null`.

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate({ files, metadata }, { checks: ["triangle-count"] });
```

For metadata display or previews, `await unpackZip(bytes)` returns `{ files,
emptyFiles }` using the same compressed-size, entry-count and inflation limits as
validation. It throws on unsafe or malformed archives and does not run checks.
Reuse these files instead of extracting uploads with an unbounded ZIP decoder.

The loader rejects cyclic GLB node hierarchies. PNG measurements reject duplicate
headers and excess scanline data, and ignore compressed profiles and text. The
streaming guard pins `pako` to 2.2.0 to preserve its bounded/truncated-input behavior.

The first visual check, `thumbnail-honesty` (V-05), uses the same API with injected `services.renderer` and `services.reviewer`. Pass a previous `result.captures` back as `captures` to reuse renders. Results carry `captures`, per-check `coverage` and `review` provenance (model, prompt version and digest, token usage). Visual discrepancies are advisory warnings; missing evidence, inconclusive answers and provider failures never pass.

Optional Node entries:

- `/rendering`: `await createRenderer({ buildDirectory })` — needs `playwright-core@1.63.0`, its full Chromium (`npx playwright-core install chromium --no-shell`) and a Unity Web build of unity-explorer PR #10053. Call `renderer.stop()` on shutdown.
- `/ai`: `createPiReviewer({ credentials })` — needs `@earendil-works/pi-ai@0.84.1` and a host-owned Pi `CredentialStore` holding an Anthropic OAuth session. One schema-constrained image request, no tools, no agent loop.

Both peers are exact pins on purpose (the browser build and the provider API are what the captures and answers were verified against); a host that already carries another patch of either must install with `--legacy-peer-deps` or match the pin. Root imports need neither. See the repository's [docs/visual-validation.md](https://github.com/dcl-regenesislabs/wearable-validator/blob/main/docs/visual-validation.md) for the run folder every review writes.

## Publishing

The package version is the rules version (`manifest.version`); bump both together. A tag publishes:

```
git tag v0.4.0 && git push origin v0.4.0
```

`.github/workflows/release.yml` builds, tests and runs `npm publish --provenance` through npm's trusted publishing, so no npm token lives in the repository. The very first version of a new package has to be published once by hand (`npm publish -w @dcl-regenesislabs/wearable-validator` from a logged-in machine); after that, set the trusted publisher on npmjs.com (package → Settings → Trusted Publisher: this repository, workflow `release.yml`) and every later tag publishes itself.
