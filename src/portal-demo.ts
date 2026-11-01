import { DASHBOARD_CSP, DASHBOARD_CSP_REPORT_ONLY } from "./dashboard-csp";
import type { Env } from "./env";
import { textResponse as text } from "./http";
import { fetchAsset, isNavigation } from "./portal-app";
import { isPortalHost } from "./portal-host";

// The Portal's chart demo (devkit live/areas.json, area 10): the same app, built a second time into
// dashboard/dist/demos/ with sample data only (dashboard/src/lib/demo.ts), and answered here at /demos/
// on portal.dustinedwards.info with NO sign-in, so a live check and a visitor see the charts a signed-in
// owner sees. It is the one public path on the Portal host besides /admin/access-drift and
// security.txt. It reads nothing from D1, KV or GitHub and takes no write: every file it serves is in
// the build, the app is the public repository's own code, and its data is dev/sample-feed.json and the
// dev mock's other fake answers (example.com sites, "sample" namespaces), captured at build time. The
// Portal itself (/ and everything else on this host) stays behind its gate, and so do its own files.
//
// The Portal signs in through Access for SaaS, so no Access application stands in front of this host
// (src/index.ts, /admin/access-drift) and no Access change is needed for this path.

const DEMO_PATH = "/demos";
const DEMO_PREFIX = "/demos/";
const HASHED_PREFIX = "/demos/assets/";
// The push service worker is for a signed-in owner's phone alerts, never for a visitor.
const NOT_SERVED = new Set(["/demos/sw.js"]);

export function isDemoRequest(url: URL): boolean {
  return isPortalHost(url) && (url.pathname === DEMO_PATH || url.pathname.startsWith(DEMO_PREFIX));
}

export async function handlePortalDemo(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed: the demo is read only.", 405, { Allow: "GET, HEAD" });
  if (!env.ASSETS) return text("The Portal's demo is not deployed: this Worker has no ASSETS binding.", 503);
  const { pathname } = new URL(request.url);
  if (pathname === DEMO_PATH) return new Response(null, { status: 308, headers: { Location: DEMO_PREFIX, "Cache-Control": "no-store" } });
  if (NOT_SERVED.has(pathname)) return text("not found", 404);

  // An app route (/demos/health) is the app's page; a missing file is a 404.
  let path = pathname.endsWith("/index.html") ? DEMO_PREFIX : pathname;
  let response = await fetchAsset(env.ASSETS, path, request.method);
  if (response.status === 404 && isNavigation(request) && !pathname.startsWith(`${DEMO_PREFIX}api/`)) {
    await response.body?.cancel();
    path = DEMO_PREFIX;
    response = await fetchAsset(env.ASSETS, path, request.method);
  }
  // The assets router never sends a visitor elsewhere from here.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return text("not found", 404);
  }

  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex");
  if (response.ok && path === DEMO_PREFIX) {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", DASHBOARD_CSP);
    headers.set("Content-Security-Policy-Report-Only", DASHBOARD_CSP_REPORT_ONLY);
  } else if (response.ok && path.startsWith(HASHED_PREFIX)) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
