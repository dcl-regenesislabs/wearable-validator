# wearable-validator

The Decentraland wearable/emote rule book as code (DAO proposal e2a13c58). npm monorepo:
`packages/wearable-validator` (published package: 35 deterministic checks + the first visual check, manifest, CLI) ·
`packages/debug-ui` (the website — validation runs fully in-browser) ·
`tools` (catalyst runner, sample generator; `tools/corpus/` holds downloaded catalyst data, blobs gitignored).

## Commands

- `npm test` / `npm run typecheck` — full suite (node:test) + tsc
- `npm run dev -w wearable-validator-debug-ui` — the website (Vite)
- `npx tsx src/cli.ts validate <file> [--checks triangle-count] [--groups model]` (from packages/wearable-validator)
- `npm run catalyst -w wearable-validator-tools -- --wearables 15 --emotes 10` — validate real published items
- `npm run samples -w wearable-validator-tools` — regenerate the website's example zips
- Deploy: push to main → Cloudflare Workers Builds → wearable-validator.dclregenesislabs.xyz (`wrangler.jsonc` at root)

## Hard rules

- **Zero crypto.** No contracts, signers, vouchers. ADR-44 signed fetch is request auth only.
- **UX & DevEx are the product.** Readable API names (`triangle-count`, never `M-01` as API — rule IDs are metadata). Every finding is creator-facing: what's wrong, where, measured vs limit, how to fix. All findings at once — never fail-fast.
- **Every number lives in `src/manifest/manifest.json`** — code holds only algorithms. Rules changes are governance acts (version = rules version).
- **One check = one folder.** `src/checks/<group>/<name>/index.ts` holds the `CheckDefinition` (algorithm + `explanation` in plain words, `fix` with concrete steps, `details` on how it measures, `docs` with the exact-section anchor, optional `measure`) and `index.test.ts` holds its tests. The group's `index.ts` lists checks in rule-book order; `registry.ts` derives every surface (explanations, fixes, details, docs links) from the definitions — completeness is test-enforced (`test/registry.test.ts`, `test/source-links.test.ts`). Shared algorithms go to `src/logic/`, Node-only adapters to `src/adapters/` (`/rendering`, `/ai`).
- Partial runs (check/group subsets, bare GLBs) return `passed: null` — never a verdict.
- The core package stays **isomorphic**: no node builtins, no native deps in `src/` (renderer/AI arrive later as optional `/rendering` and `/ai` entries; AI = pi-ai one pinned call, never an agent loop).

## Style

ESM (`type: module`, `.js`-suffixed relative imports, `node:` builtins), strict minimal tsconfig, kebab-case modules, no barrels beyond a group's `index.ts`, `interface` + string-literal unions, plain `new Error("actionable sentence")`, node:test colocated as `index.test.ts` next to each check (cross-cutting suites stay in `test/`, fixtures in `test/helpers/` imported as `#test/helpers/...`), exact-pin risky deps with a why-comment. The website uses dcl-editor's design tokens verbatim (see packages/debug-ui/src/styles.css header).

## Reference docs

The RFC (rules + rationale + sources) lives in Notion: "RFC — Wearable & Emote Validator" (DCL Regenesis Labs). The interactive rule book and build plan are Claude artifacts owned by @gonpombo.
