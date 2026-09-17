import type { HandlerContextWithPath } from "../../types.js";

/** The built website at /, with index.html for the routes the single-page app owns; nothing when no site is built. */
export async function siteHandler(context: Pick<HandlerContextWithPath<"site", "/(.*)">, "components" | "url">) {
  const { site } = context.components;
  if (!site.root) return { status: 404, body: { message: "No website is served here. Run the Vite dev server, or build the site and set SITE_DIR." } };
  let path: string;
  try {
    path = decodeURIComponent(context.url.pathname);
  } catch {
    return { status: 404, body: { message: "Not found." } };
  }
  const file = await site.file(path);
  if (!file) return { status: 404, body: { message: "Not found." } };
  return { status: 200, headers: { "content-type": file.contentType, "cache-control": "no-cache" }, body: file.bytes };
}
