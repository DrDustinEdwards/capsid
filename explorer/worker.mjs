// The explorer's Worker, which answers only paths with no file (wrangler-config.mjs sets
// not_found_handling "none", so the asset server answers every file itself, with _headers). It
// sends dist/404.html with the explorer's security set and charset=utf-8: no _headers rule can name
// a path with no file, so the asset server's own 404 page went out as a bare text/html.
import { applyHeaderSet } from "@dustinedwards/site-runtime/headers";
import { explorerSecurityHeaders } from "./src/security-headers.mjs";

const SET = explorerSecurityHeaders();

export default {
  /** @param {Request} request @param {{ ASSETS: { fetch(request: Request): Promise<Response> } }} env */
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
    // dist/404.html, served at /404 by html_handling.
    const page = await env.ASSETS.fetch(new Request(new URL("/404", request.url)));
    const notFound = new Response(request.method === "HEAD" ? null : page.body, { status: 404, headers: page.headers });
    applyHeaderSet(notFound.headers, SET);
    return notFound;
  },
};
