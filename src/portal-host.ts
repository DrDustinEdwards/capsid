// Capsid Portal on its own host ("one address pattern for the family"):
// https://portal.dustinedwards.info, a Custom Domain on this Worker. It is a
// separate origin from every public site, and its cookies are host-only.
//
// The Portal's routes are written once, under /portal (src/routes.ts). On the Portal host a
// request for /x is handled as /portal/x, so every route, the gate and every check apply
// unchanged. On the Portal host a browser asking for /portal/... is sent to the same path
// at the root (308), so an old link lands on the new address. The build's hashed files (/assets/...) are answered before this rewrite
// (src/portal-app.ts portalAsset).
// One exception: /health is the Worker's own health route on this host too (area 8, H1, round 2),
// so the Portal's address answers the shared health with the deployed sha without a sign-in.
// It reports what mcp.dustinedwards.info/health reports, never a document. Cloudflare Access
// in front of the host lets it through only with its own Bypass application for
// portal.dustinedwards.info/health, which the seat sets in Cloudflare. Nothing else is
// reachable on the Portal host: /mcp and the /ops routes are on mcp.dustinedwards.info
// (src/mcp-host.ts), and on this host they are Portal paths behind the gate. The other
// exception is /admin/access-drift, the drift check's hashed admin list, answered in
// src/index.ts before this rewrite.

// The same values as portal-auth's PORTAL_PATH and PORTAL_PREFIX, stated here rather than
// imported, because portal-auth imports this module.
import { isSameOriginPath } from "@dustinedwards/site-runtime/url";

const PORTAL_PATH = "/portal";
const PORTAL_PREFIX = "/portal/";

export const PORTAL_HOST = "portal.dustinedwards.info";
const HEALTH_PATH = "/health";

export function isPortalHost(url: URL): boolean {
  return url.hostname === PORTAL_HOST;
}

/** Where the Portal's cookies are scoped: the whole Portal host, or /portal elsewhere.
 *  Never a Domain attribute, so no other subdomain of the family can read or set them. */
export function portalCookiePath(url: URL): string {
  return isPortalHost(url) ? "/" : PORTAL_PATH;
}

/** An internal Portal path (/portal, /portal/x) as the browser on this host names it. */
export function publicPortalPath(url: URL, internal: string): string {
  if (!isPortalHost(url)) return internal;
  if (internal === PORTAL_PATH) return "/";
  return internal.startsWith(PORTAL_PREFIX) ? internal.slice(PORTAL_PATH.length) : internal;
}

/** On the Portal host: a redirect for an old /portal path, or the request rewritten to its
 *  internal /portal path. Anywhere else: the request unchanged. */
export function portalHostRequest(request: Request): { redirect: Response } | { request: Request } {
  const url = new URL(request.url);
  if (!isPortalHost(url)) return { request };
  const path = url.pathname;
  if (path === HEALTH_PATH) return { request };
  const underPortal = path === PORTAL_PATH || path.startsWith(PORTAL_PREFIX);
  if (underPortal) {
    const publicPath = publicPortalPath(url, path);
    // /portal//attacker.example would otherwise become a 308 to https://attacker.example/,
    // carrying an OAuth code or a phishing visitor off the host (Grok audit 2026-10, C1).
    if (!isSameOriginPath(publicPath))
      return { redirect: new Response("Not found", { status: 404 }) };
    const target = new URL(publicPath + url.search, url.origin);
    // 308 keeps the method and body, so a stray POST to an old address is not turned
    // into a GET.
    return {
      redirect: new Response(null, {
        status: 308,
        headers: { Location: target.toString(), "Cache-Control": "no-store" },
      }),
    };
  }
  const inner = new URL(url);
  inner.pathname = path === "/" ? PORTAL_PREFIX : PORTAL_PATH + path;
  return { request: new Request(inner.toString(), request) };
}
