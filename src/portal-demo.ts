import { renderDemoPage } from "capsid-portal-pages";
import { dashboardCsp } from "./dashboard-csp";
import type { Env } from "./env";
import { textResponse as text } from "@dustinedwards/site-runtime/http";
import { pageHeaders, serveFile } from "./portal-app";
import { isPortalHost } from "./portal-host";

// The Portal's chart demo (devkit live/areas.json, area 10): the same pages, rendered here at
// /demos/ on portal.dustinedwards.info with sample data and NO sign-in, so a live check and a
// visitor see the charts a signed-in owner sees.

const DEMO_PATH = "/demos";
const DEMO_PREFIX = "/demos/";
// The push service worker and the manifest are for a signed-in owner's phone, never for a visitor.
const NOT_SERVED = new Set(["/demos/sw.js", "/demos/site.webmanifest"]);

export function isDemoRequest(url: URL): boolean {
  return isPortalHost(url) && (url.pathname === DEMO_PATH || url.pathname.startsWith(DEMO_PREFIX));
}

export async function handlePortalDemo(
  request: Request,
  env: Env,
  render = renderDemoPage,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return text("method not allowed: the demo is read only.", 405, { Allow: "GET, HEAD" });
  const assets = env.ASSETS;
  if (!assets)
    return text("The Portal's demo is not deployed: this Worker has no ASSETS binding.", 503);
  const { pathname } = new URL(request.url);
  if (NOT_SERVED.has(pathname)) return text("not found", 404);

  // A captured answer is a file; every other address is a page.
  if (pathname.startsWith(`${DEMO_PREFIX}api/`)) {
    return serveFile(assets, pathname, request.method, {
      "X-Robots-Tag": "noindex",
      "Cache-Control": "no-store",
    });
  }

  const csp = dashboardCsp();
  const page = await render(request, (path) => serveFile(assets, path, "GET", {}), csp.nonce);
  const out = pageHeaders(page, csp);
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
}
