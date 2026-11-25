import type { PortalMergeUnits } from "./ops-types/views";
import { REPORT_KEY, readSuspended, type UnitsReport } from "./merge-units";
import { behindGate } from "./portal-auth";
import { jsonResponse as json } from "@dustinedwards/site-runtime/http";

// The Portal's Merge units panel (docs/autonomy.md, "Earned promotion and demotion"): GET
// /portal/api/merge-units.

export const PORTAL_MERGE_UNITS_PATH = "/portal/api/merge-units";

// The suspended units and the proposals. Two KV gets. A promote proposal for a unit that is
// suspended now cannot stand, so it is left out; an unreadable report is no proposals.
export async function readMergeUnits(kv: KVNamespace): Promise<PortalMergeUnits> {
  const [suspended, raw] = await Promise.all([readSuspended(kv), kv.get(REPORT_KEY)]);
  let report: Pick<UnitsReport, "generated" | "proposals"> | null = null;
  try {
    report = raw ? (JSON.parse(raw) as UnitsReport) : null;
  } catch {
    report = null;
  }
  const suspendedUnits = new Set(suspended.map((s) => s.unit));
  return {
    generated: report?.generated ?? null,
    suspended,
    proposals: (report?.proposals ?? [])
      .filter((p) => p.kind === "demote" || !suspendedUnits.has(p.unit))
      .map((p) => ({ kind: p.kind, unit: p.unit, title: p.title })),
  };
}

/** GET /portal/api/merge-units. */
export const handlePortalMergeUnits = behindGate(async (_request, env) => {
  return json(await readMergeUnits(env.APP_KV));
});
