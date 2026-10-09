import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalStale } from "./ops-types";
import { portalGate } from "./portal-auth";
import { staleJobs } from "./stale-jobs";

// The Portal's stale jobs: GET /portal/api/stale (capsid/research/design-stale-jobs.md,
// settled: its own route, since OPS_FEED_READS is pinned and the feed does not grow a
// read). The same reader as `jobs` action list with stale: true (src/stale-jobs.ts), so
// the Portal and chat cannot disagree, over every namespace. It costs no GitHub reads:
// the pull request states come from the cache the merge-resume step writes. A route, not
// a tool, so no grant is checked here (CLAUDE.md, one enforcement point rule): it answers
// to portalGate, and src/scope.ts lists it among the routes gated some other way.

export const PORTAL_STALE_PATH = "/portal/api/stale";

/** GET /portal/api/stale: the jobs that look stuck, each with its rule and reason. */
export async function handlePortalStale(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const read = await staleJobs(env, now);
  const body: PortalStale = { generated: now.toISOString(), rows: read.rows, truncated: read.truncated, note: read.note ?? null };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
