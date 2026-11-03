import { renderPortalPage } from "capsid-portal-pages";
import { dashboardCsp } from "./dashboard-csp";
import type { Env } from "./env";
import { PORTAL_PATH, portalGate } from "./portal-auth";
import { isPortalHost } from "./portal-host";
import { textResponse as text } from "./http";

// Capsid Portal (capsid/research/design-ops-console.md, moved from /console/app/ by
// capsid/research/design-portal-unify.md): React Router pages rendered here, on the server, with
// their data (dashboard/, its README), as every network site renders its own. Every request goes
// through portalGate first: a page is the admin's dashboard, and a page served before the gate is
// a page served to anyone. The router matches /portal/callback and every /portal/api/ path before
// this handler. The page's reads are the Portal's own API routes, called here with the visitor's
// request, so each passes the same gate and checks as the browser's later reads.
//
// The build's hashed files (/assets/...) are public and served before the gate (portalAsset):
// they are this public repository's code and carry no data. The other files the build holds (the
// manifest, the icons, the push service worker) stay behind the gate.
//
// That ordering holds only while the Worker runs before the assets router. The deployed config
// must set `assets.run_worker_first: true` (docs/portal.md): without it, Cloudflare serves a
// request that matches a file without invoking this Worker. No test here can prove that
// setting: the integration pool's SELF is the Worker itself, not the assets router
// (vitest.config.ts says more), so it is a deploy-config check, not a test.

/** Hashed build output, named by content, so a changed file has a new name. */
export const HASHED_ASSET_CACHE = "public, max-age=31536000, immutable";
const HASHED_ASSET_PREFIX = "/assets/";

const NOT_DEPLOYED =
  "Capsid Portal is not deployed: this Worker has no ASSETS binding. The built app (dashboard/build/client) is served only when the deploy config declares it.";

/** A file's path ends in an extension; a page's does not (/health, /queue/job/abc). React
 *  Router's own data requests (/health.data) and its route manifest are pages' answers. */
function isFile(path: string): boolean {
  return /\.[a-z0-9]+$/i.test(path) && !path.endsWith(".data");
}

export function fetchAsset(assets: Fetcher, path: string, method: string): Promise<Response> {
  // The hostname is not meaningful to the binding; only the pathname is matched.
  return assets.fetch(new Request(new URL(path, "https://assets.invalid"), { method }));
}

/** The response a page leaves with: never cached, and its policy carrying the page's nonce. */
export function pageHeaders(response: Response, csp: { policy: string; reportOnly: string }): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  // Referrer-Policy, X-Frame-Options and the rest come from withSecurityHeaders (src/security-headers.ts).
  headers.set("Content-Security-Policy", csp.policy);
  headers.set("Content-Security-Policy-Report-Only", csp.reportOnly);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** On the Portal host, a hashed build file, served to anyone (the demo's pages load the same
 *  files); null for anything else. */
export async function portalAsset(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isPortalHost(url) || !url.pathname.startsWith(HASHED_ASSET_PREFIX)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed: the Portal's files are read with GET.", 405, { Allow: "GET, HEAD" });
  if (!env.ASSETS) return text("not found", 404);
  const response = await fetchAsset(env.ASSETS, url.pathname, request.method);
  // The assets router never sends a visitor elsewhere from here.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return text("not found", 404);
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", response.ok ? HASHED_ASSET_CACHE : "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** One of the Portal's API routes (/portal/api/<path>), answered in this Worker. */
export type PortalApi = (request: Request) => Promise<Response>;

export async function handlePortalApp(request: Request, env: Env, api: PortalApi, now: Date = new Date(), render = renderPortalPage): Promise<Response> {
  const url = new URL(request.url);
  const gate = await portalGate(request, env, now, url.pathname);
  if (!gate.ok) return gate.response;
  if (!env.ASSETS) return text(NOT_DEPLOYED, 503);
  if (request.method !== "GET" && request.method !== "HEAD") return text("method not allowed: the Portal's pages are read with GET.", 405, { Allow: "GET, HEAD" });

  const inner = url.pathname.slice(PORTAL_PATH.length) || "/";
  if (isFile(inner)) {
    const response = await fetchAsset(env.ASSETS, inner, request.method);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    // A redirect from the assets router is not followed or forwarded: a file has one address.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return text("not found", 404);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  // The page, named as the browser on the Portal host names it (/health), with the visitor's
  // headers, so its reads carry the same session. The pages are written from the Portal's root
  // (dashboard/src/routes.ts), so the internal /portal prefix goes on every host.
  const page = new Request(new URL(inner + url.search, url.origin), { method: request.method, headers: request.headers });
  // A read's cookies reach the browser with the page: the feed mints the CSRF cookie on a
  // session's first read (src/ops-feed.ts), and the page carries that read's value.
  const cookies: string[] = [];
  const read = async (path: string) => {
    const headers = new Headers(request.headers);
    headers.set("Accept", "application/json");
    const response = await api(new Request(new URL(`${PORTAL_PATH}/api${path}`, url.origin), { headers }));
    cookies.push(...response.headers.getSetCookie());
    return response;
  };
  const csp = dashboardCsp();
  const out = pageHeaders(await render(page, read, csp.nonce), csp);
  for (const cookie of cookies) out.headers.append("Set-Cookie", cookie);
  return out;
}
