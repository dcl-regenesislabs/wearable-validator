# Deployment

- **Web** — wearable-validator.dclregenesislabs.xyz, Cloudflare Workers (`wrangler.jsonc`), behind Cloudflare Access: curators sign in with their email, then the site runs the code checks in the browser and the visual review through the run server.
- **Worker** — `packages/web/worker.ts` forwards `/api/*` to `API_ORIGIN` = api.wearable-validator.dclregenesislabs.xyz, headers and streamed body intact (SSE included).
- **Backend** — one container (the root `Dockerfile`) on DigitalOcean App Platform, proxied through Cloudflare.
- **Identity** — the server verifies the Access JWT the Worker forwards (`packages/server/src/adapters/access.ts`); every run belongs to the email that started it, and the API only ever shows a caller their own runs. Service tokens (the Slack bot) and the emails in `OPERATORS` see everything; service tokens change nothing (`POST`/`DELETE` answer 403).
- **Which build is running** — the Docker build reads the commit from the checkout's `.git/HEAD` into `packages/server/build-info.json`; `/api/health` and `/api/stats` answer `build: { version, commit, builtAt, startedAt }`, the startup log line carries the same, and the Slack bot's `stats` question reports it.
- **Self-test** — at startup the server checks the two things a render depends on and says so in the log: the hosts it must reach (`cdn.decentraland.org` for the pinned wrapper, `peer.decentraland.org` for the avatar the previewer loads) and whether Chromium gets a WebGPU device in this container. A render that hangs with an idle CPU is one of those two; `RENDERER_SELF_TEST=0` skips it.
- **Logs** — one JSON line per event on stdout: every API request (caller, status, ms), each run's gate, queue, captures, model calls and result, and the browser's own story (launch, previewer load or failure with the last wrapper messages, page crashes, console errors, retried views). Operators can read the recent lines through `GET /api/logs`. Refused requests (bad Host, no sign-in, 403) are counted in the `refused_requests_total` metric and printed at debug level with the Host hashed; they never enter that log. `GET /metrics` serves the Prometheus registry (HTTP defaults, `runs_accepted_total`, `runs_finished_total{status}`, `render_duration_seconds`, `refused_requests_total{reason}`) on the server itself, outside the Host and sign-in checks: set `WKC_METRICS_BEARER_TOKEN` before exposing the port.

## One-time setup

### 1. Upload the Unity build

The Docker image downloads the PR #10053 renderer build from a GitHub release asset and checks its sha256. The build must include the render-profile parameters (`renderScale`, `hdr`, `shadowMap`, `postProcessing` in `PreviewConfiguration.cs`) or the manifest's `rendering.quality` has no effect and every frame is drawn at twice the size. The tarball is at `tools/artifacts/renderer-build.tar.gz` (23 MB, sha256 `f5667806f56cfd5d7dc927540a29dcbb3ef21ad89a2ec3693673746472109fbf`):

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

### 3. The run server on a droplet

Software rendering is CPU-bound: on App Platform's shared vCPUs the first view of a run took six minutes, and memory never passed 2 GB. A dedicated-CPU droplet is faster and cheaper than the equivalent App Platform tier, so that is where the server runs.

1. Create a **CPU-Optimized droplet, 4 dedicated vCPUs / 8 GB**, Ubuntu with Docker preinstalled (the Docker Marketplace image). Nothing else runs on it.
2. Cloudflare Zero Trust → Networks → Tunnels → create a tunnel, add a public hostname `api.wearable-validator.dclregenesislabs.xyz` pointing at `http://validator:4180`, and copy the tunnel token. The tunnel means the droplet needs no open port, no certificate and no firewall rules.
3. On the droplet:

```sh
git clone https://github.com/dcl-regenesislabs/wearable-validator.git
cd wearable-validator
cp deploy/env.example deploy/.env    # fill in the tunnel token, the setup token, OPERATOR_TOKEN, CF_ACCESS_*
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f validator
```

The first build takes a few minutes: it pulls the Playwright image, installs Chromium and downloads the pinned Unity build (§1). The log then shows the self-test: the dependencies it reached and whether WebGPU draws.

4. Redeploy after a merge: `git pull && docker compose -f deploy/docker-compose.yml up -d --build`.
5. The named volumes keep run folders and Chromium's profile across restarts, so a restarted container renders warm (the App Platform disk forgot both).

### 3b. Deploy on merge

A merge to `main` redeploys the run server through `.github/workflows/deploy.yml`: it connects to the droplet, fast-forwards the checkout, rebuilds the image and waits for `/api/health` to answer, printing the container log if it does not. `.github/workflows/ci.yml` runs typecheck, tests and the build on every pull request.

Three repository secrets make it work (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `DROPLET_HOST` | the droplet's IP |
| `DROPLET_SSH_KEY` | a private key whose public half is in the droplet's `/root/.ssh/authorized_keys`; generate a dedicated one with `ssh-keygen -t ed25519 -C wearable-validator-deploy -f deploy-key -N ""` and keep it out of the repo |

The droplet's public host key is pinned in the workflow itself (`ssh-keyscan -t ed25519 <ip>`); a rebuilt droplet needs that line updated. Until the secrets are set the workflow fails on the first step and nothing else is affected. A deploy can also be started by hand from the Actions tab.

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
