import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import { packageHistory, readPackageRow, type FetchLike } from "./ops-packages";
import { portalGate } from "./portal-auth";

// The Packages view's on-demand history: GET /portal/api/packages/history?name=. The
// daily downloads come from npm's range API when the view asks, not pass by pass
// (capsid/decisions.md, 2026-09-29), and are cached (src/ops-packages.ts). A route, not
// a tool, so no grant is checked here (CLAUDE.md, one enforcement point rule): it
// answers to portalGate, and src/scope.ts lists it among the routes gated some other
// way. Only a configured package can be asked for, so the route cannot be used to
// fetch any name from npm.

export const PORTAL_PACKAGE_HISTORY_PATH = "/portal/api/packages/history";

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handlePortalPackageHistory(
  request: Request,
  env: Env,
  now: Date = new Date(),
  fetchImpl: FetchLike = (url, init) => fetch(url, init)
): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 214) return textResponse("name must be a configured package's npm name.", 400);
  const cfg = await readPackageRow(env.DB, name);
  if (!cfg) return textResponse(`${name} is not a configured package.`, 404);
  const body = await packageHistory(env, cfg, fetchImpl, now);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
