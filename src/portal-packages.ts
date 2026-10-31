import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import { packageHistory, readPackageRow, type FetchLike } from "./ops-packages";
import { portalGate } from "./portal-auth";
import { readSharedCode } from "./shared-code";
import { readCompleteness } from "./completeness";
import { textResponse } from "./http";
import { notFoundReport } from "@dustinedwards/site-runtime/not-found";
import type { PortalNotFound } from "./ops-types/sites";

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

// The Sites view's 404 panel (area 8, N4): GET /portal/api/not-found. Capsid's own counts,
// page_404_daily, read with site-runtime's notFoundReport; each other site keeps its table in
// its own D1, which Capsid does not read. Gated like the reads above; it reads D1 only.
export const PORTAL_NOT_FOUND_PATH = "/portal/api/not-found";
const NOT_FOUND_DAYS = 30;

export async function handlePortalNotFound(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  let body: PortalNotFound;
  try {
    const all = await notFoundReport(env.DB, { days: NOT_FOUND_DAYS, limit: 500, includeProbes: true, now });
    const pages = all.filter((e) => e.kind === "page").slice(0, 50).map(({ path, hits, referrers }) => ({ path, hits, referrers }));
    body = { days: NOT_FOUND_DAYS, generated: now.toISOString(), pages, probes: all.filter((e) => e.kind === "probe").reduce((n, e) => n + e.hits, 0), error: null };
  } catch (err) {
    body = { days: NOT_FOUND_DAYS, generated: now.toISOString(), pages: null, probes: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
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
