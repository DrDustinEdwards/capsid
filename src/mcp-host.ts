// The MCP endpoint on the family domain (capsid/decisions.md 2026-10-01, "one address
// pattern for the family"; job_2f9671f89e89, approved as a same-day cut):
// https://mcp.dustinedwards.info, a Custom Domain on this Worker.
//
// That host serves the machine surface and nothing else: the MCP endpoints, the OAuth
// flow that authorizes them, the /ops routes keys and runners call, the scorer's signed
// endpoints, /health and the CSP report sink. Any other path there is the plain 404, so
// the host never answers with the Portal or a page; the Portal has its own host
// (src/portal-host.ts). It runs first in the Worker's fetch, with the Portal's rewrite,
// before the OAuth provider (the lesson of #226).
//
// The old address, capsid.dustin-edwards.workers.dev, answers for the hours the cut
// takes, and then the deploy config turns workers.dev off. Its /portal is retired now:
// capsid-login no longer lists its sign-in callback, so it is the plain 404, as /console was.

export const MCP_HOST = "mcp.dustinedwards.info";
export const MCP_URL = `https://${MCP_HOST}/mcp`;
export const LEGACY_HOST = "capsid.dustin-edwards.workers.dev";
export const LEGACY_MCP_URL = `https://${LEGACY_HOST}/mcp`;

// Exact paths the MCP host serves, and the prefixes under which it serves everything.
const MCP_HOST_PATHS = new Set([
  "/mcp",
  "/authorize",
  "/token",
  "/callback",
  "/health",
  "/csp-report",
  "/improve/score",
  "/improve/holdout-credential",
  "/backup/credential",
]);
const MCP_HOST_PREFIXES = ["/mcp/", "/ops/", "/.well-known/oauth-"];

export function servedOnMcpHost(pathname: string): boolean {
  return MCP_HOST_PATHS.has(pathname) || MCP_HOST_PREFIXES.some((p) => pathname.startsWith(p));
}

/** The Worker's own 404, the same body as the routes handler's fallback. */
function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/** A request the host rules answer at once (the MCP host's unserved paths, the old
 *  address's retired /portal), or null when the request goes on. */
export function hostRefusal(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname === MCP_HOST && !servedOnMcpHost(url.pathname)) return notFound();
  if (url.hostname === LEGACY_HOST && (url.pathname === "/portal" || url.pathname.startsWith("/portal/"))) return notFound();
  return null;
}
