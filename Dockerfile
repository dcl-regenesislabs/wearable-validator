# Run server image: Playwright's Chromium (full headless, SwiftShader WebGPU) + the Unity build + the server.
# Build from the repo root:  docker build -t wearable-validator-server .
# Lives at the root so DigitalOcean App Platform detects it; the build context is the whole repo.
# Run:  docker run --rm --shm-size=1g --memory=4g -p 4180:4180 -e ANTHROPIC_OAUTH_SETUP_TOKEN=... \
#         -e CF_ACCESS_TEAM_DOMAIN=... -e CF_ACCESS_AUD=... wearable-validator-server
# stage 1: the commit this image was built from, read from the checkout's .git (HEAD, refs and packed-refs are the
# only .git files in the build context); the server shows it in /api/health so operators know what is running
FROM alpine:3.20 AS gitinfo
WORKDIR /src
COPY .git .git
RUN ref=$(sed -n 's/^ref: //p' .git/HEAD); \
    if [ -n "$ref" ] && [ -f ".git/$ref" ]; then sha=$(cat ".git/$ref"); \
    elif [ -n "$ref" ] && [ -f .git/packed-refs ]; then sha=$(grep " $ref$" .git/packed-refs | cut -c1-40); \
    else sha=$(cat .git/HEAD); fi; \
    printf '{"commit":"%s","builtAt":"%s"}' "${sha:-unknown}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /build-info.json && cat /build-info.json

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ARG RENDERER_BUILD_URL=https://github.com/dcl-regenesislabs/wearable-validator/releases/download/renderer-build-1/renderer-build.tar.gz
ARG RENDERER_BUILD_SHA256=f5667806f56cfd5d7dc927540a29dcbb3ef21ad89a2ec3693673746472109fbf
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/wearable-validator/package.json packages/wearable-validator/
COPY packages/server/package.json packages/server/
RUN npm ci --no-audit --no-fund --ignore-scripts
# the Playwright image ships Chromium for its own version; playwright-core@1.63.0 must match it
RUN npx playwright-core install chromium --no-shell
# the PR #10053 Unity build is too big for git: a pinned release asset, verified before it is unpacked
RUN curl -fsSL "$RENDERER_BUILD_URL" -o /tmp/renderer-build.tar.gz \
  && echo "$RENDERER_BUILD_SHA256  /tmp/renderer-build.tar.gz" | sha256sum -c - \
  && mkdir -p /app/packages/server/renderer-build \
  && tar -xzf /tmp/renderer-build.tar.gz -C /app/packages/server/renderer-build \
  && rm /tmp/renderer-build.tar.gz
COPY tsconfig.base.json ./
COPY packages/wearable-validator ./packages/wearable-validator
COPY packages/server ./packages/server
COPY --from=gitinfo /build-info.json ./packages/server/build-info.json
ENV RENDERER_BUILD=/app/packages/server/renderer-build
# Linux Chromium reaches SwiftShader WebGPU only through Vulkan; without those two flags pipeline creation fails.
# Hosted containers (App Platform) give /dev/shm 64 MB, far too small for this page: --disable-dev-shm-usage moves
# Chromium's shared memory to /tmp. CHROMIUM_ARGS is an operator-trusted knob spliced straight into the launch arguments.
ENV CHROMIUM_ARGS="--enable-features=Vulkan --use-vulkan=swiftshader --disable-dev-shm-usage"
ENV LOG_FORMAT=json
ENV HOST=0.0.0.0
# Chromium loads creator-supplied models: never as root. pwuser ships with the Playwright image.
RUN chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 4180
CMD ["npm", "start", "-w", "wearable-validator-server"]
