# Deployment

- **Web** — wearable-validator.dclregenesislabs.xyz, Cloudflare Workers (`wrangler.jsonc`), behind Cloudflare Access: curators sign in with their email, then the site runs the code checks in the browser and the visual review through the run server.
- **Worker** — `packages/web/worker.ts` forwards `/api/*` to `API_ORIGIN` = api.wearable-validator.dclregenesislabs.xyz, headers and streamed body intact (SSE included).
- **Backend** — one container (the root `Dockerfile`) on DigitalOcean App Platform, proxied through Cloudflare.
- **Identity** — the server verifies the Access JWT the Worker forwards (`packages/server/src/access.ts`); every run belongs to the email that started it, and the API only ever shows a caller their own runs.

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
| `HOST` | `0.0.0.0` |
| `PUBLIC_HOSTS` | `api.wearable-validator.dclregenesislabs.xyz` |
| `CF_ACCESS_TEAM_DOMAIN` | from step 2 |
| `CF_ACCESS_AUD` | from step 2 |
| `ANTHROPIC_OAUTH_SETUP_TOKEN` | **secret** — a `claude setup-token` (`sk-ant-oat…`, valid about a year); the only model credential |
| `MAX_CONCURRENT_RUNS` | `1` — renders at once; raise it with RAM (one per ~2 GB). Everyone else waits in the line the site shows |
| `LOG_FORMAT` | `json` |
| `CHROMIUM_ARGS` | leave unset: the image sets `--enable-features=Vulkan --use-vulkan=swiftshader --disable-dev-shm-usage` (the last one because App Platform gives `/dev/shm` only 64 MB; without it the previewer never reports load) |
| `ARTIFACTS_DIR` | `/app/packages/server/artifacts` — the container disk is ephemeral: every run folder vanishes on redeploy or restart |

The server refuses to start on a non-loopback `HOST` without the two Access variables (unless `INSECURE_ANONYMOUS=1`, which makes every caller owner `anonymous` and is for local Docker smoke tests only).

6. Settings → Domains → add `api.wearable-validator.dclregenesislabs.xyz`; App Platform shows the CNAME target. In Cloudflare DNS create that CNAME, proxied (orange cloud), and set the zone's SSL/TLS mode to **Full (strict)**. If App Platform's certificate stays *Pending*, switch the record to *DNS only* until it shows *Active*, then turn the proxy on. The proxy is not a gate: the container trusts only JWTs whose signature, issuer and audience verify (`packages/server/src/access.ts`), and the Host check answers 403 on the `*.ondigitalocean.app` name.

### 4. Workers

Workers & Pages → `wearable-validator` → Settings → Build: build command `npm ci && npm run build -w wearable-validator-web`, deploy command `npx wrangler deploy`. Every push to `main` redeploys the site; `API_ORIGIN` is in `wrangler.jsonc`, nothing to set in the dashboard. Until the Access application (step 2) exists the site is public and the run server answers 401 to everyone; the Access login is what makes the visual review work.

### 5. Smoke test

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

- ADR-44 signed fetch identity for the Builder (owner = wallet address). The seam is `packages/server/src/identity.ts` (`Identify`); `localIdentity` and `accessIdentity` are the two providers today.
- Run retention: nothing deletes old run folders, and the App Platform disk forgets them on every deploy.
- A daily spend cap on model calls.
