import type { Finding } from "./watcher";

// ANOMALY RULES ON THE AUDIT LOG (OWASP agentic hardening item 6, ASI10;
// capsid/research/design-owasp-hardening.md; Dustin's D4 of 2026-10-03: a hit is a watcher
// finding plus a Portal attention item, nothing more. No suspension and no revoke: that
// is re-decided after two weeks of measured false positives. D5 dropped the path rule.)
//
// Per minted agent (actor "agent:<name>", the watcher itself excepted), the last 24 hours
// against the 14 days before them, from audit_log counted per actor, action and hour:
//   - a new action: an action the agent wrote in the last day and never in its baseline.
//     An agent with no baseline at all is judged by the first-use rule instead;
//   - a rate spike: its busiest hour in the last day over RATE_FACTOR times its busiest
//     baseline hour, and at least RATE_FLOOR rows, so a quiet agent's second call is not
//     a spike;
//   - an off-hours first use: an agent with no baseline whose first row falls between
//     00:00 and 06:00 America/Chicago.
// The window is a day so a hit stays a finding for a day, then clears itself.
//
// What audit_log cannot see, it cannot judge: a read that writes no audit row is not
// counted. The hook receiver's session rows (job_5ac1139641e0, D1) are the place to
// widen it when they exist.

const BASELINE_DAYS = 14;
const RECENT_HOURS = 24;
const RATE_FACTOR = 3;
export const RATE_FLOOR = 30;
const OFF_HOURS_END = 6;

/** One row of the grouped read: an actor's rows of one action in one UTC hour. */
export interface ActionHour {
  actor: string;
  action: string;
  // "YYYY-MM-DDTHH", UTC.
  hour: string;
  n: number;
}

/** The window's start for readActionHours, in audit_log's datetime format. */
function anomalySince(now: Date): string {
  return new Date(now.getTime() - (BASELINE_DAYS * 24 + RECENT_HOURS) * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

/** The read the rules run on: every minted agent's audit rows of the last BASELINE_DAYS
 *  plus one days, grouped by action and hour, the watcher (`except`) left out. On the
 *  audit_log_at index (migrations/0005), bounded by the window. */
export async function readActionHours(db: D1Database, now: Date, except: string): Promise<ActionHour[]> {
  const { results } = await db
    .prepare(
      `SELECT actor, action, strftime('%Y-%m-%dT%H', at) AS hour, COUNT(*) AS n
       FROM audit_log WHERE at >= ?1 AND actor LIKE 'agent:%' AND actor <> ?2
       GROUP BY actor, action, hour`
    )
    .bind(anomalySince(now), except)
    .all<ActionHour>();
  return results ?? [];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/^agent:/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/** The hour of day in America/Chicago for a UTC hour key. */
export function chicagoHour(hourKey: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(new Date(`${hourKey}:00:00Z`));
  return Number(h) % 24;
}

const mk = (fingerprint: string, headline: string, evidence: string[]): Finding => ({
  fingerprint,
  namespace: "capsid",
  title: `Watcher: ${headline} [${fingerprint}]`,
  body: [
    "An agent acted out of its usual pattern (OWASP item 6, anomaly rules). A finding only:",
    "nothing was suspended or revoked (Dustin, D4 of 2026-10-03). Confirm whether the",
    "activity was expected; if it was, fail this job saying so, which counts toward the",
    "false-positive measure. If it was not, revoke the key with the agents tool.",
    "",
    "## Evidence",
    "",
    ...evidence.map((line) => `- ${line}`),
  ].join("\n"),
  evidence,
});

export function anomalyFindings(rows: readonly ActionHour[], now: Date): Finding[] {
  const recentFrom = new Date(now.getTime() - RECENT_HOURS * 3600_000).toISOString().slice(0, 13);
  const byActor = new Map<string, { base: ActionHour[]; recent: ActionHour[] }>();
  for (const r of rows) {
    const a = byActor.get(r.actor) ?? { base: [], recent: [] };
    (r.hour >= recentFrom ? a.recent : a.base).push(r);
    byActor.set(r.actor, a);
  }
  const out: Finding[] = [];
  for (const [actor, { base, recent }] of [...byActor].sort(([x], [y]) => x.localeCompare(y))) {
    if (recent.length === 0) continue;
    const perHour = (list: ActionHour[]) => {
      const m = new Map<string, number>();
      for (const r of list) m.set(r.hour, (m.get(r.hour) ?? 0) + r.n);
      return m;
    };
    if (base.length === 0) {
      const first = [...recent].sort((x, y) => x.hour.localeCompare(y.hour))[0];
      const local = chicagoHour(first.hour);
      if (local < OFF_HOURS_END) {
        out.push(mk(`anomaly-first-use-${slug(actor)}`, `${actor} was first used at ${String(local).padStart(2, "0")}:00 Chicago time`, [`first audit row in the hour ${first.hour}:00Z (${first.action})`, `no row in the ${BASELINE_DAYS} days before`]));
      }
      continue;
    }
    const known = new Set(base.map((r) => r.action));
    const fresh = [...new Set(recent.map((r) => r.action))].filter((a) => !known.has(a)).sort();
    for (const action of fresh) {
      const n = recent.filter((r) => r.action === action).reduce((s, r) => s + r.n, 0);
      out.push(mk(`anomaly-new-action-${slug(actor)}-${slug(action)}`, `${actor} did '${action}', which it had not done in ${BASELINE_DAYS} days`, [`${n} row(s) of '${action}' in the last ${RECENT_HOURS} hours`, `its baseline actions: ${[...known].sort().join(", ")}`]));
    }
    const baseMax = Math.max(...perHour(base).values());
    const [peakHour, peak] = [...perHour(recent)].sort((x, y) => y[1] - x[1])[0];
    if (peak >= RATE_FLOOR && peak > RATE_FACTOR * baseMax) {
      out.push(mk(`anomaly-rate-${slug(actor)}`, `${actor} wrote ${peak} audit rows in one hour, over ${RATE_FACTOR} times its busiest`, [`${peak} rows in the hour ${peakHour}:00Z`, `its busiest hour in the ${BASELINE_DAYS} days before: ${baseMax}`]));
    }
  }
  return out;
}
