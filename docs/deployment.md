# Deployment

- **Web** — wearable-validator.dclregenesislabs.xyz, Cloudflare Workers (`wrangler.jsonc`), behind Cloudflare Access: curators sign in with their email, then the site runs the code checks in the browser and the visual review through the run server.
- **Worker** — `packages/web/worker.ts` forwards `/api/*` to `API_ORIGIN` = api.wearable-validator.dclregenesislabs.xyz, headers and streamed body intact (SSE included).
- **Backend** — one container (the root `Dockerfile`) on DigitalOcean App Platform, proxied through Cloudflare.
- **Identity** — the server verifies the Access JWT the Worker forwards (`packages/server/src/adapters/access.ts`); every run belongs to the email that started it, and the API only ever shows a caller their own runs. Service tokens (the Slack bot) and the emails in `OPERATORS` see everything; service tokens change nothing (`POST`/`DELETE` answer 403).
- **Logs** — one JSON line per event on stdout: every API request (caller, status, ms), each run's gate, queue, captures, model calls and result, and the browser's own story (launch, previewer load or failure with the last wrapper messages, page crashes, console errors, retried views). Operators can read the recent lines through `GET /api/logs`. Refused requests (bad Host, no sign-in, 403) are counted in the `refused_requests_total` metric and printed at debug level with the Host hashed; they never enter that log. `GET /metrics` serves the Prometheus registry (HTTP defaults, `runs_accepted_total`, `runs_finished_total{status}`, `render_duration_seconds`, `refused_requests_total{reason}`) on the server itself, outside the Host and sign-in checks: set `WKC_METRICS_BEARER_TOKEN` before exposing the port.

## One-time setup

### 1. Upload the Unity build

The Docker image downloads the PR #10053 renderer build from a GitHub release asset and checks its sha256. The tarball is at `tools/artifacts/renderer-build.tar.gz` (23 MB, sha256 `f5667806f56cfd5d7dc927540a29dcbb3ef21ad89a2ec3693673746472109fbf`):

```sh
gh release create renderer-build-1 tools/artifacts/renderer-build.tar.gz \
  --repo dcl-regenesislabs/wearable-validator \
  --title "renderer-build-1" \
  --notes "Unity Web build of unity-explorer PR #10053 (avatar-preview-renderer). sha256 f5667806f56cfd5d7dc927540a29dcbb3ef21ad89a2ec3693673746472109fbf"
```

To re-pin after a new Unity build: `COPYFILE_DISABLE=1 tar -czf renderer-build.tar.gz -C <Build dir> avatar-preview-renderer.loader.js avatar-preview-renderer.framework.js avatar-preview-renderer.wasm avatar-preview-renderer.data` (the four files at the tarball's top level and nothing else: without `COPYFILE_DISABLE` macOS adds `._*` metadata entries that GNU tar unpacks as junk files), `shasum -a 256 renderer-build.tar.gz`, create release `renderer-build-2` the same way, then update the two `ARG` defaults (`RENDERER_BUILD_URL`, `RENDERER_BUILD_SHA256`) in the root `Dockerfile`.

### 2. Cloudflare Zero Trust (Access)

1. Zero Trust → Access → Applications → **Add an application** → Self-hosted.
2. Application domain: `wearable-validator.dclregenesislabs.xyz`.
3. Policy: Allow, include the curators' emails (or the Workspace domain).
4. Save, then copy from the application's overview the **Application Audience (AUD) tag** → `CF_ACCESS_AUD`. The team domain is the slug before `.cloudflareaccess.com` (e.g. `dclregenesislabs`) → `CF_ACCESS_TEAM_DOMAIN`.
5. Settings → Cookie settings → **SameSite attribute: Lax**, so the Access cookie never rides on a request another site starts (the server also refuses cross-site and non-`application/zip` uploads; this is the second lock).

### 3. DigitalOcean App Platform (the run server)

1. Create App → GitHub → this repo, branch `main`, source directory empty, **Autodeploy on push**. App Platform detects the root `Dockerfile` (that is why it lives there) and builds with it; no build or run command.
2. Resource type Web Service, HTTP port `4180`.
3. One instance with **4 GB RAM and 2 dedicated vCPUs** (rendering is software-only and CPU-bound; 1 vCPU risks command timeouts) (a render peaks at ~1.7 GB plus Chromium and Node; the server admits one run at a time. Measured in Docker with `--memory=2g`: a run completes at a 1.84 GiB peak, too tight to recommend).
4. Health check: HTTP, path `/api/health`.
5. Environment variables:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` (alias of `HTTP_SERVER_HOST`; `PORT` likewise stands in for `HTTP_SERVER_PORT`) |
| `PUBLIC_HOSTS` | `api.wearable-validator.dclregenesislabs.xyz` |
| `CF_ACCESS_TEAM_DOMAIN` | from step 2 |
| `CF_ACCESS_AUD` | from step 2 |
| `ANTHROPIC_OAUTH_SETUP_TOKEN` | **secret** — a `claude setup-token` (`sk-ant-oat…`, valid about a year); the only model credential |
| `OPERATOR_TOKEN` | **secret**, a long random string (32+ characters); the Slack bot sends it as a Bearer token and becomes operator `service:bot` (step 5) |
| `OPERATORS` | optional comma-separated curator emails that may also read every run, the stats and the log |
| `MAX_CONCURRENT_RUNS` | `1` — renders at once; raise it with RAM (one per ~2 GB). Everyone else waits in the line the site shows |
| `LOG_FORMAT` | `json` |
| `RENDER_COMMAND_TIMEOUT_MS` | optional; the manifest's 15 s per previewer command is tuned for a developer machine. On 2 vCPUs the first view alone took over a minute; set 120000 to measure how long each view really takes there (`captured … ms` lines) before choosing an instance size |
| `CHROMIUM_ARGS` | leave unset: the image sets `--enable-features=Vulkan --use-vulkan=swiftshader --disable-dev-shm-usage` (the last one because App Platform gives `/dev/shm` only 64 MB; without it the previewer never reports load) |
| `ARTIFACTS_DIR` | `/app/packages/server/artifacts` — the container disk is ephemeral: every run folder vanishes on redeploy or restart |
| `MAX_UPLOAD_BYTES` | default `33554432` (32 MB); a larger upload answers 413 |
| `UPLOAD_TIMEOUT_MS` | default `60000`; a request (headers and body) must arrive within it |
| `MAX_ACTIVE_RUNS_PER_OWNER` | default `3` runs waiting or rendering per owner; the next answers 429 |
| `MAX_WAITING_RUNS` | default `20` runs in the line; beyond it uploads answer 503 |
| `MAX_RUNS_PER_OWNER_PER_DAY` | default `40` renders per owner per 24 h; the next answers 429 saying when a slot opens |
| `MAX_SSE_LISTENERS_PER_RUN` | default `5` tabs following one run; the next answers 429 |
| `WKC_METRICS_BEARER_TOKEN` | **secret** — required as `Authorization: Bearer` on `GET /metrics`; unset, anyone who reaches the port can read the metrics |

Every key and its default is in `packages/server/.env.default` (committed, no secrets); the environment wins over it. Set a limit only to change it. The server reads no other `.env` file, and `.env` / `.env.*` are gitignored so a local copy holding a token is never committed.

The server refuses to start on a non-loopback host without the two Access variables (unless `INSECURE_ANONYMOUS=1`, which makes every caller owner `anonymous` and is for local Docker smoke tests only).

6. Settings → Domains → add `api.wearable-validator.dclregenesislabs.xyz`; App Platform shows the CNAME target. In Cloudflare DNS create that CNAME, proxied (orange cloud), and set the zone's SSL/TLS mode to **Full (strict)**. If App Platform's certificate stays *Pending*, switch the record to *DNS only* until it shows *Active*, then turn the proxy on. The proxy is not a gate: the container trusts only JWTs whose signature, issuer and audience verify (`packages/server/src/adapters/access.ts`), and the Host check answers 403 on the `*.ondigitalocean.app` name.

### 4. Workers

Workers & Pages → `wearable-validator` → Settings → Build: build command `npm ci && npm run build -w wearable-validator-web`, deploy command `npx wrangler deploy`. Every push to `main` redeploys the site; `API_ORIGIN` is in `wrangler.jsonc`, nothing to set in the dashboard. Until the Access application (step 2) exists the site is public and the run server answers 401 to everyone; the Access login is what makes the visual review work.

### 5. The Slack bot (or any operator script)

The bot is the one machine caller, so it gets a shared secret instead of a login:

1. Pick a long random secret (32+ characters) and keep it only in the two environments below.
2. Validator app on App Platform → environment → `OPERATOR_TOKEN` = that value, encrypted. Redeploy.
3. Slack bot → environment → `WEARABLE_VALIDATOR_TOKEN` = the same value, encrypted. Its `wearable-validator` skill calls `https://api.wearable-validator.dclregenesislabs.xyz` directly with `Authorization: Bearer <token>`; the server compares it in constant time and treats the caller as operator `service:bot`.

Check from a terminal: `curl -s -H "Authorization: Bearer <token>" https://api.wearable-validator.dclregenesislabs.xyz/api/stats` answers JSON.

The token is read-only: it never starts or cancels a run (403), and `/api/health` reports `owner: null` for it. Operator endpoints, all JSON: `GET /api/stats` (totals, by day, by curator, average render time, queue), `GET /api/runs?all=1` (every run with its owner), `GET /api/runs/<id>` for any run, `GET /api/logs?limit=200&since=<ISO time>` (the server's recent log lines, kept in memory since the last restart). Rotating the secret is changing the two variables. Cloudflare Access service tokens (a "Service Auth" policy on the application) are also accepted as operators, for a caller that should not hold a shared secret.

### 6. Smoke test

1. Two curators sign in at wearable-validator.dclregenesislabs.xyz (Access login). The Visual review panel header says **Signed in as <email>**.
2. Each drops a zip and gets a streamed run.
3. Each sees only their own run under **Your runs** (`GET /api/runs`).
4. Paste the other person's run URL (`/api/runs/<id>/events`) into the browser: `404 { "message": "Unknown run." }`.
5. `curl https://api.wearable-validator.dclregenesislabs.xyz/api/health` answers `{ "ok": true, …, "owner": null }`; `curl …/api/runs` answers 401.

## Local development

```sh
# single local owner, no Access, site built into the server at http://127.0.0.1:4180
ANTHROPIC_OAUTH_SETUP_TOKEN=<claude setup-token> npm run serve

# the image itself (defaults: the pinned release asset; to test another build pass BOTH args, the sha256 check has no bypass)
docker build -t wearable-validator-server .
docker build --build-arg RENDERER_BUILD_URL=<url> --build-arg RENDERER_BUILD_SHA256=<sha256 of that tarball> -t wearable-validator-server .
docker run --rm --shm-size=1g --memory=4g -p 4180:4180 -e INSECURE_ANONYMOUS=1 wearable-validator-server
```

Leave the token out and the server renders and writes the prompt without calling the model.

## What is not done yet

- ADR-44 signed fetch identity for the Builder (owner = wallet address). The seam is `packages/server/src/adapters/identity.ts` (`Identify`); `localIdentity` and `accessIdentity` are the two providers today.
- Run retention: nothing deletes old run folders, and the App Platform disk forgets them on every deploy.
- A daily spend cap on model calls.
