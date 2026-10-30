import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import { packageHistory, readPackageRow, type FetchLike } from "./ops-packages";
import { portalGate } from "./portal-auth";
import { readSharedCode } from "./shared-code";
import { readCompleteness } from "./completeness";
import { textResponse } from "./http";

// The Packages view's on-demand history: GET /portal/api/packages/history?name=. The
// daily downloads come from npm's range API when the view asks, not pass by pass
// and are cached (src/ops-packages.ts). A route, not
// a tool, so no grant is checked here (one enforcement point, test/route-gates.test.ts): it
// answers to portalGate, and src/scope.ts lists it among the routes gated some other
// way. Only a configured package can be asked for, so the route cannot be used to
// fetch any name from npm.

export const PORTAL_PACKAGE_HISTORY_PATH = "/portal/api/packages/history";

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

// The Shared code view's read: GET /portal/api/shared-code (src/shared-code.ts). Like the
// history above it answers to portalGate and nothing else, writes only its own hour-long
// cache, and reads GitHub only for the configured packages and the configured sites' repos.
export const PORTAL_SHARED_CODE_PATH = "/portal/api/shared-code";

export async function handlePortalSharedCode(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const body = await readSharedCode(env, now);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// The Completeness view's read: GET /portal/api/completeness (src/completeness.ts). devkit's
// daily scoreboard, read through the GitHub App from devkit's scoreboard branch. Gated and
// cached like the Shared code view above; it reads that one file and nothing else.
export const PORTAL_COMPLETENESS_PATH = "/portal/api/completeness";

export async function handlePortalCompleteness(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const body = await readCompleteness(env, now);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
