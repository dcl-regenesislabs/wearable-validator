# wearable-validator

The Decentraland wearable & emote rule book as code — every publication check as a runnable function, in node and the browser.

Mandated by [DAO proposal e2a13c58](https://decentraland.org/governance/proposal/?id=e2a13c58-d66d-412d-802f-83190d063636): automate the objective half of wearable curation.

## Try it

```bash
npm install

# the website: drop a wearable/emote, see every check pass or fail
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
| `apps/debug-ui` | the website: upload → per-check results with plain explanations, concrete how-to-fix steps, exact-section docs links, and a live 3D preview |
| `tools` | catalyst runner (validate published items) + sample generator |
| `corpus/` | downloaded catalyst content (blobs gitignored) + validation reports |

Every check carries a rule-book ID (`M-01`…), a plain-language explanation, fix guidance, and a docs link — all exported from the package (`checks`, `explanations`, `fixes`) so no surface can drift from the code.

Rendering checks (headless renderer) and AI checks (IP/policy screening) land later as optional entries (`/rendering`, `/ai`); the design docs live in the project's planning workspace.

```ts
import { validate } from "@dcl-regenesislabs/wearable-validator";

const result = await validate(zipBytes);
result.passed;    // true | false | null (advisory runs never mint a verdict)
result.findings;  // every problem at once: message, where, measured vs limit, fix, docs
```
