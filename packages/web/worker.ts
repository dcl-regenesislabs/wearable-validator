/**
 * Cloudflare Worker in front of the built site (root wrangler.jsonc). Static files come from the ASSETS binding;
 * `/api/*` is forwarded as-is to the run server named by API_ORIGIN, so the Access JWT, cookies and the streamed
 * upload body reach it and its SSE responses stream back. Without API_ORIGIN (the public site) every /api call is a 404.
 */
export type Fetch = (request: Request) => Promise<Response>;

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API_ORIGIN?: string;
  // the network, injectable so tests never patch the global fetch
  fetch?: Fetch;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.API_ORIGIN) return Response.json({ message: "No run server is configured for this site." }, { status: 404 });
    const forward = env.fetch ?? ((target: Request) => fetch(target));
    return forward(new Request(env.API_ORIGIN + url.pathname + url.search, request));
  }
};
