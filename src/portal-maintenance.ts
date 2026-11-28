import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { ROSTER } from "./roster";
import { readMaintenance } from "./maintenance";
import type { PortalMaintenance } from "./ops-types/views";
import { behindGate } from "./portal-auth";

// The Portal's Maintenance list: GET /portal/api/maintenance. The list the daily maintenance pass
// stored, the same one capsid_read_status action status serves per namespace, so the Portal and
// chat cannot disagree. It reads KV only and runs nothing: the pass runs on the five-minute tick
// once a day.

export const PORTAL_MAINTENANCE_PATH = "/portal/api/maintenance";

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

/** GET /portal/api/maintenance: the last pass's list and what it read. */
export const handlePortalMaintenance = behindGate(async (_request, env) => {
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
        },
      }
    : {
        generated: null,
        items: [],
        read: { prs: 0, branches: 0, repos: 0, roster: ROSTER.length },
      };
  return jsonResponse(body);
});
