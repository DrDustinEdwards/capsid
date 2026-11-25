// The MCP endpoint on the family domain: https://mcp.dustinedwards.info, a Custom Domain on this
// Worker. That host serves the machine surface only: the MCP endpoints, the OAuth flow, the /ops
// routes keys and runners call, the signed backup and bench endpoints, /health and the CSP report
// sink.

export const MCP_HOST = "mcp.dustinedwards.info";
export const MCP_URL = `https://${MCP_HOST}/mcp`;

const MCP_HOST_PATHS = new Set([
  "/mcp",
  "/authorize",
  "/token",
  "/callback",
  "/register",
  "/health",
  "/csp-report",
  "/backup/credential",
  "/backup/offaccount-report",
  "/bench/tasks",
  "/bench/draw",
  "/bench/start",
  "/bench/repro",
  "/bench/score",
  "/review/run",
  "/public/model/v1.json",
  "/public/stats/v1.json",
  "/public/code/v1.json",
  "/public/versions/v1.json",
  "/oauth/clients/verify-live.json",
  "/reports/signed-in-security.json",
  "/owner",
]);
const MCP_HOST_PREFIXES = ["/mcp/", "/ops/", "/.well-known/oauth-", "/owner/"];

export function servedOnMcpHost(pathname: string): boolean {
  return MCP_HOST_PATHS.has(pathname) || MCP_HOST_PREFIXES.some((p) => pathname.startsWith(p));
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

export function hostRefusal(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname === MCP_HOST && !servedOnMcpHost(url.pathname)) return notFound();
  return null;
}
