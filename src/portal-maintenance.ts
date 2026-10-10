import type { Env } from "./env";
import { ROSTER } from "./improve-schema";
import { readMaintenance } from "./maintenance";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalMaintenance } from "./ops-types";
import { portalGate } from "./portal-auth";

// The Portal's Maintenance list: GET /portal/api/maintenance (job_549550d73d4e). The list
// the daily maintenance pass stored, the same one improve_status serves per namespace, so
// the Portal and chat cannot disagree. It reads KV only and runs nothing: the pass runs on
// the five-minute tick once a day. A route, not a tool, so no grant is checked here
// (CLAUDE.md, one enforcement point rule): it answers to portalGate, and src/scope.ts lists
// it among the routes gated some other way.

export const PORTAL_MAINTENANCE_PATH = "/portal/api/maintenance";

const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

/** GET /portal/api/maintenance: the last pass's list and what it read. */
export async function handlePortalMaintenance(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const list = await readMaintenance(env);
  const body: PortalMaintenance = list
    ? {
        generated: list.generated,
        items: list.items,
        read: {
          prs: sum(list.prs_read),
          branches: sum(list.branches_read),
          repos: Object.keys(list.prs_read).length,
          roster: ROSTER.length,
          deploys: Object.keys(list.deploys_read).length,
          disk: list.disk_read,
        },
      }
    : { generated: null, items: [], read: { prs: 0, branches: 0, repos: 0, roster: ROSTER.length, deploys: 0, disk: 0 } };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
