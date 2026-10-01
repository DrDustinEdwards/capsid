// Capsid Portal on its own host (capsid/decisions.md 2026-10-01, "one address pattern for
// the family"): https://portal.dustinedwards.info, a Custom Domain on this Worker. It is a
// separate origin from every public site, and its cookies are host-only.
//
// The Portal's routes are written once, under /portal (src/routes.ts). On the Portal host a
// request for /x is handled as /portal/x, so every route, the gate and every check apply
// unchanged; the workers.dev /portal keeps answering as before until the new address is
// verified live, and is then retired by a follow-up PR. Two exceptions on the Portal host:
//   - a browser asking for /portal/... is sent to the same path at the root (308), so an
//     old link lands on the new address;
//   - /portal/assets/... is served as it is, not redirected. The built app names its
//     hashed files by that absolute path (dashboard/vite.config.ts base), on both hosts.
// Nothing else is reachable on the Portal host: /mcp, /health and the /ops routes stay on
// capsid.dustin-edwards.workers.dev, and on this host they are Portal paths behind the gate.

// The same values as portal-auth's PORTAL_PATH and PORTAL_PREFIX, stated here rather than
// imported, because portal-auth imports this module.
const PORTAL_PATH = "/portal";
const PORTAL_PREFIX = "/portal/";

export const PORTAL_HOST = "portal.dustinedwards.info";
const PORTAL_ASSETS_PREFIX = "/portal/assets/";

export function isPortalHost(url: URL): boolean {
  return url.hostname === PORTAL_HOST;
}

/** The Portal's path as the browser sees it: "" on the Portal host, "/portal" elsewhere. */
export function portalBase(url: URL): string {
  return isPortalHost(url) ? "" : PORTAL_PATH;
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
  const underPortal = path === PORTAL_PATH || path.startsWith(PORTAL_PREFIX);
  if (underPortal && !path.startsWith(PORTAL_ASSETS_PREFIX)) {
    const target = new URL(publicPortalPath(url, path) + url.search, url.origin);
    // 308 keeps the method and body, so a stray POST to an old address is not turned
    // into a GET.
    return { redirect: new Response(null, { status: 308, headers: { Location: target.toString(), "Cache-Control": "no-store" } }) };
  }
  if (underPortal) return { request };
  const inner = new URL(url);
  inner.pathname = path === "/" ? PORTAL_PREFIX : PORTAL_PATH + path;
  return { request: new Request(inner.toString(), request) };
}
