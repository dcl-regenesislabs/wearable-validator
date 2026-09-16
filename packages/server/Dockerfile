# Run server image: Playwright's Chromium (full headless, SwiftShader WebGPU) + the Unity build + the server.
# Build from the repo root:  docker build -f packages/server/Dockerfile -t wearable-validator-server .
# Run:  docker run --rm --shm-size=1g --memory=4g -p 4180:4180 -e ANTHROPIC_OAUTH_SETUP_TOKEN=... \
#         -e CF_ACCESS_TEAM_DOMAIN=... -e CF_ACCESS_AUD=... wearable-validator-server
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
ENV RENDERER_BUILD=/app/packages/server/renderer-build
# Linux Chromium reaches SwiftShader WebGPU only through Vulkan; without these two flags pipeline creation fails.
# CHROMIUM_ARGS is an operator-trusted knob spliced straight into the launch arguments.
ENV CHROMIUM_ARGS="--enable-features=Vulkan --use-vulkan=swiftshader"
ENV LOG_FORMAT=json
ENV HOST=0.0.0.0
# Chromium loads creator-supplied models: never as root. pwuser ships with the Playwright image.
RUN chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 4180
CMD ["npm", "start", "-w", "wearable-validator-server"]
