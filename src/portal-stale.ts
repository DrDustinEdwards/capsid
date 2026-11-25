import { jsonResponse } from "@dustinedwards/site-runtime/http";
import type { PortalStale } from "./ops-types/views";
import { behindGate } from "./portal-auth";
import { staleJobs } from "./stale-jobs";

// The Portal's stale jobs: GET /portal/api/stale (capsid/research/design-stale-jobs.md, settled:
// its own route, since OPS_FEED_READS is pinned and the feed does not grow a read).

export const PORTAL_STALE_PATH = "/portal/api/stale";

/** GET /portal/api/stale: the jobs that look stuck, each with its rule and reason. */
export const handlePortalStale = behindGate(async (_request, env, now) => {
  const read = await staleJobs(env, now);
  const body: PortalStale = {
    generated: now.toISOString(),
    rows: read.rows,
    truncated: read.truncated,
    note: read.note ?? null,
  };
  return jsonResponse(body);
});
