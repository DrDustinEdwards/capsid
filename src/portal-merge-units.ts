import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalMergeUnits } from "./ops-types/views";
import { REPORT_KEY, readSuspended, type UnitsReport } from "./merge-units";
import { portalGate } from "./portal-auth";
import { jsonResponse as json } from "./http";

// The Portal's Merge units panel (docs/autonomy.md, "Earned promotion and demotion"):
// GET /portal/api/merge-units. The suspended units as the tick reads them (the list a lift
// changes) and the promote and demote proposals of the units tick's last report, so the panel
// can offer unit_resume and sign_policy_change on each. Its own route, read when the Pull
// requests page opens, since OPS_FEED_READS is pinned and the feed does not grow a read. A
// route, not a tool, so no grant is checked here (one enforcement point,
// test/route-gates.test.ts): it answers to portalGate, and src/scope.ts lists it among the
// routes gated some other way.

export const PORTAL_MERGE_UNITS_PATH = "/portal/api/merge-units";

/** The suspended units and the proposals. Two KV gets. A promote proposal for a unit that is
 *  suspended now cannot stand, so it is left out; an unreadable report is no proposals. */
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
export async function handlePortalMergeUnits(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  return json(await readMergeUnits(env.APP_KV));
}
