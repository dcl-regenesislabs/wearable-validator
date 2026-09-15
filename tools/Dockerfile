# Linux smoke test for the headless renderer: Chromium (full headless, SwiftShader WebGPU) + the Unity build.
# Build from the repo root:  docker build -f tools/Dockerfile -t wearable-validator-renderer .
# Run one render:            docker run --rm --shm-size=1g --memory=4g wearable-validator-renderer
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
# Linux Chromium reaches SwiftShader WebGPU only through Vulkan; without these two flags pipeline creation fails.
# CHROMIUM_ARGS is an operator-trusted knob spliced straight into the launch arguments.
ENV CHROMIUM_ARGS="--enable-features=Vulkan --use-vulkan=swiftshader"
ENV LOG_FORMAT=json
# Chromium loads creator-supplied models: never as root. pwuser ships with the Playwright image.
RUN chown -R pwuser:pwuser /app
USER pwuser
CMD ["npm", "run", "visual:review", "-w", "wearable-validator-tools", "--", "packages/debug-ui/public/samples/upper_body.zip", "--no-ai", "--standalone", "--out", "/tmp/artifacts"]
