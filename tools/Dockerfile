# Linux smoke test for the headless renderer: Chromium (full headless, SwiftShader WebGPU) + the Unity build.
# Build from the repo root:  docker build -f tools/Dockerfile -t wearable-validator-renderer .
# Run one render:            docker run --rm -e NODE_OPTIONS=--max-old-space-size=2048 wearable-validator-renderer
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/wearable-validator/package.json packages/wearable-validator/
COPY packages/debug-ui/package.json packages/debug-ui/
COPY tools/package.json tools/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages ./packages
COPY tools ./tools
COPY tsconfig.base.json ./
# the Playwright image ships Chromium for its own version; playwright-core@1.63.0 must match it
RUN npx playwright-core install chromium --no-shell
ENV LOG_FORMAT=json
CMD ["npm", "run", "visual:review", "-w", "wearable-validator-tools", "--", "packages/debug-ui/public/samples/upper_body.zip", "--no-ai", "--standalone", "--out", "/tmp/artifacts"]
