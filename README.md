# wearable-validator

A shared validator for new Decentraland wearable and emote submissions, designed for Builder integration and server-side validation. It checks the item’s files together with the metadata, representations, and content list supplied by the caller.

The standalone website is a debug and showcase surface: bare GLB uploads run the available file/model checks, while published items and bundled samples demonstrate richer item context. A GLB does not need to embed Decentraland metadata: Builder or the server supplies it through `validate({ files, metadata, content })`. S-03 validates supplied item metadata with the official `Wearable.validate` or `Emote.validate` schema and reports field paths and values. Builder ZIP manifests use their smaller required-field checks; bare GLBs remain partial runs.

Mandated by [DAO proposal e2a13c58](https://decentraland.org/governance/proposal/?id=e2a13c58-d66d-412d-802f-83190d063636): automate the objective half of wearable curation.

## Try it

```bash
npm install

# the website: drop a GLB and choose its type/category to check its limits
npm run dev -w wearable-validator-debug-ui

# the CLI
cd packages/wearable-validator
npx tsx src/cli.ts validate my-wearable.zip
npx tsx src/cli.ts validate model.glb --item-type wearable --category hat
npx tsx src/cli.ts validate my-wearable.zip --checks triangle-count,skeleton
npx tsx src/cli.ts checks        # list all checks with plain-language explanations

# validate real published catalyst items
npm run catalyst -w wearable-validator-tools -- --wearables 15 --emotes 10
```

## What's here

| | |
|---|---|
| `packages/wearable-validator` | the published package: 35 deterministic checks (files · model · emote · content), rules manifest, CLI. Isomorphic — the website runs it fully in the browser, nothing is uploaded |
| `packages/debug-ui` | the website: upload → filterable per-rule results with separate values, requirements, and colored status labels (including on mobile), inspectable metadata fields, plain explanations, concrete how-to-fix steps, exact-section docs links, and a live 3D preview |
| `tools` | catalyst runner (validate published items), sample generator, and `tools/corpus/` — downloaded catalyst content (blobs are a gitignored cache) + validation reports |

Every check carries a rule-book ID (`M-01`…), a plain-language explanation, fix guidance, and a docs link — all exported from the package (`checks`, `explanations`, `fixes`) so no surface can drift from the code.

Rendering checks (headless renderer) and AI checks (IP/policy screening) land later as optional entries (`/rendering`, `/ai`); the design docs live in the project's planning workspace.

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate(zipBytes);
result.passed;    // true | false | null (advisory runs never mint a verdict)
result.findings;  // every problem at once: message, where, measured vs limit, fix, docs
```

## Browser content-integrity regression

Run `npm run test:browser -w wearable-validator-debug-ui`, then open
http://127.0.0.1:4174. The production-bundled scene must show `PASS`: a known
content hash matches, and altered bytes produce a mismatch instead of a crashed
check. This scene reproduced the browser hashing failure before the fix.

Content hashes support both legacy Decentraland `Qm…` whole-file hashes and
UnixFS CIDv1 hashes, using the format declared for each file. The UnixFS importer
is pinned to preserve Decentraland compatibility. Node tests compare empty, single-chunk, and multi-chunk files with
`@dcl/hashing`, which is retained only as a test reference.

## Emote playback regression

Run `npm run dev -w wearable-validator-debug-ui` and open
http://localhost:5173/test/emote-playback.html. With internet access, the scene
loads the bundled emote in the hosted previewer and must show `PASS` after testing
Pause, Play, and Restart from a paused position. It checks actual playback events
and button labels; before the fix, commands were ignored and the scene timed out.

## Validation correctness regressions

Run `node --import tsx --test packages/wearable-validator/test/correctness.test.ts`
from the repository root. These cases cover invalid rarity/body-shape metadata,
emote categories, distinct materials with repeated names, per-representation
measurements, bounding-box boundaries, and flat/nested Builder spring settings.
Numeric bounds are compared before display formatting. Metadata checks validate
supplied item metadata against the full platform schema, while Builder manifests
require name/category and a valid rarity when supplied. Run
`node --import tsx --test packages/wearable-validator/test/metadata-schema.test.ts`
for complete wearable/emote fixtures, missing and malformed fields, duplicate
locales, and input-mode regressions.
