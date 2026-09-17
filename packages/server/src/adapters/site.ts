/** Files from inside a root folder, and nothing outside it: the built website and every run folder. */
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { appLogger } from "./log-buffer.js";

const ROOT = resolve(import.meta.dirname, "../../../..");

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".zip": "application/zip", ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".ico": "image/x-icon"
};

export interface StaticFile {
  bytes: Buffer;
  contentType: string;
}

/** One file from inside root; anything that escapes root, is missing or is not a file is undefined, never a read. */
export async function fileWithin(root: string, relativePath: string): Promise<StaticFile | undefined> {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (!target.startsWith(base + "/") && target !== base) return undefined;
  try {
    const info = await stat(target);
    if (!info.isFile()) return undefined;
    return { bytes: await readFile(target), contentType: CONTENT_TYPES[extname(target)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}

export interface ISiteComponent {
  /** The built site's folder; undefined when nothing is built (the Vite dev server proxies /api instead). */
  readonly root?: string;
  /** The file for a site path, index.html for the root and for extension-less routes the SPA owns; undefined when the site is not built or the file is missing. */
  file(path: string): Promise<StaticFile | undefined>;
}

export async function createSiteComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<ISiteComponent> {
  const { config, logs } = components;
  const configured = await config.getString("SITE_DIR");
  const root = resolve(process.env.INIT_CWD ?? process.cwd(), configured ?? join(ROOT, "packages/web/dist"));
  const built = await stat(join(root, "index.html")).then(() => true).catch(() => false);
  if (!built) appLogger(logs, "site").warn("no built website to serve: run npm run build -w wearable-validator-web, or use the Vite dev server", { site: root });
  return {
    root: built ? root : undefined,
    file: async (path) => {
      if (!built) return undefined;
      const clean = path.replace(/^\/+/, "");
      const found = await fileWithin(root, clean === "" ? "index.html" : clean);
      if (found || extname(clean)) return found;
      return fileWithin(root, "index.html");
    }
  };
}
