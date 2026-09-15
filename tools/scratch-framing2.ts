import { readFileSync } from "node:fs";
import { loadInput } from "../packages/wearable-validator/src/loader.js";
import { manifest } from "../packages/wearable-validator/src/manifest/index.js";
import { launchChromium, mountPreview, pageSession, previewItem, previewUrl, readLocalBuild, routeAssets, stableScreenshot, waitForLoad } from "../packages/wearable-validator/src/adapters/rendering.js";
const bytes = new Uint8Array(readFileSync("../packages/debug-ui/public/samples/upper_body.zip"));
const { ctx } = await loadInput(bytes, {});
const item = previewItem({ files: ctx!.files, item: ctx!.item, itemType: "wearable", category: ctx!.category! });
const assets = await readLocalBuild("renderer-build");
const s = manifest.rendering;
for (const extra of ["disableAutoCenter=true", ""]) {
  const browser = await launchChromium({ gpu: "software" });
  const context = await browser.newContext({ viewport: { width: s.imageSizePx, height: s.imageSizePx }, serviceWorkers: "block" });
  await routeAssets(context, assets);
  const page = await context.newPage();
  const session = pageSession(page, s);
  await mountPreview(page, previewUrl() + (extra ? `&${extra}` : ""), s.imageSizePx);
  await waitForLoad(page, 0, s.loadTimeoutMs);
  for (let i = 0; i < 3; i++) {
    await session.update(item, { bodyShape: s.bodyShapes[0], type: "wearable", profile: s.profile, emote: s.wearablePose });
    await session.request("emote", "pause", []);
    const len = (await session.request("emote", "getLength", [])) as number;
    await session.request("emote", "goTo", [len * s.wearablePoseFraction]);
    await session.pause(s.settleMs);
    const { pixels, bytes: png } = await stableScreenshot(session);
    console.log(extra || "default", `#${i}`, pixels.slice(0, 12));
    if (i === 0) (await import("node:fs/promises")).writeFile(`/tmp/framing-${extra ? "nocenter" : "default"}.png`, png);
  }
  await browser.close();
}
