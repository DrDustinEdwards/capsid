import { z } from "zod";
import type { Env } from "./env";
import { bounded } from "./limits";
import { readSnapshot } from "./ops-snapshot";
import { MINUTE_MS, DAY_MS } from "./time";

// The public aggregate numbers (ruling capsid/rulings/system-explorer-2026-10-10.md,
// section 3 and answer 5; design capsid/research/design-system-explorer.md, section 2;
// docs/public-data.md). Counts, rates and medians over every namespace, agent and site
// at once, computed once a UTC day over whole days ending at midnight. Never a title, a
// body, a name, an email, error text, or a time of day: the only strings are the date
// and the short sha /health already shows.
//
// A rate or median over fewer than FLOOR rows is null, so one job cannot be read off it.

export const FLOOR = 10;

const Count = z.number().int().min(0);
const Rate = z.number().min(0).max(1).nullable();

export const PublicStatsSchema = z.strictObject({
  version: z.literal(1),
  as_of: bounded(10).regex(/^\d{4}-\d{2}-\d{2}$/),
  jobs: z.strictObject({
    completed_7d: Count,
    completed_30d: Count,
    failed_30d: Count,
    // Eight whole weeks, oldest first, each ending at a midnight.
    completed_by_week: z.array(Count).length(8),
    // The same eight weeks. The three weekly series added on 2026-10-23 are optional only so the
    // explorer still parses a document the public build wrote before they existed.
    failed_by_week: z.array(Count).length(8).optional(),
    open: Count,
    blocked: Count,
    median_duration_minutes_30d: Count.nullable(),
  }),
  verification: z.strictObject({
    evaluations_90d: Count,
    agreement_rate_90d: Rate,
    pr_merge_rate_90d: Rate,
    ci_green_rate_90d: Rate,
    // Agreement in each of the eight weeks, null for a week under the floor.
    agreement_by_week: z.array(Rate).length(8).optional(),
  }),
  gates: z.strictObject({
    waits_30d: Count,
    median_wait_minutes_30d: Count.nullable(),
    share_ended_by_policy_30d: Rate,
    waits_by_week: z.array(Count).length(8).optional(),
  }),
  sites: z.strictObject({
    watched: Count,
    uptime_7d: Rate,
    slots_measured_7d: Count,
  }),
  store: z.strictObject({ documents: Count, namespaces: Count }),
  systems: z.strictObject({ public: Count, private: Count }).nullable(),
  capsid: z.strictObject({ sha7: bounded(7).regex(/^[0-9a-f]{7}$|^unknown$/) }),
});

export type PublicStats = z.infer<typeof PublicStatsSchema>;

/** The rows the numbers are computed from, each already limited to its window. */
export interface StatsRows {
  /** Jobs that finished (done or failed) in the last 56 days: status and when. */
  finished: Array<{ status: string; updated_at: string }>;
  /** Open jobs by status, read at the build. */
  open: Array<{ status: string; n: number }>;
  /** job_outcomes in the last 90 days. */
  outcomes: Array<{ recorded_at: string; duration_minutes: number | null; prs_opened: number | null; prs_merged: number | null; ci_green: number | null; verified: string }>;
  /** job_evaluations' agreement in the last 90 days, and when each was recorded. */
  evaluations: Array<{ agreement: string; recorded_at: string }>;
  /** Touches that ended a wait in the last 56 days, and when. */
  waits: Array<{ actor_kind: string; waited_ms: number; at: string }>;
  /** Each watched site's uptime ring ('1' up, '0' down, '-' not measured). */
  rings: string[];
  documents: number;
  namespaces: number;
  systems: { public: number; private: number } | null;
  sha: string | undefined;
}

function rate(num: number, den: number): number | null {
  return den < FLOOR ? null : Math.round((num / den) * 1000) / 1000;
}

function median(values: number[]): number | null {
  if (values.length < FLOOR) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

function verifiedFields(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Corrupt means nothing verified, as in src/agent-record.ts.
    return {};
  }
}

/** Midnight UTC at the start of `now`'s day: every window ends here. */
function windowEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const since = (end: Date, days: number) => new Date(end.getTime() - days * DAY_MS).toISOString();

/** The public numbers from their rows. Pure, and the only place the rules live. */
export function summarize(rows: StatsRows, now: Date): PublicStats {
  const end = windowEnd(now);
  const endIso = end.toISOString();
  const inWindow = (at: string, days: number) => at >= since(end, days) && at < endIso;

  // Eight whole weeks, oldest first: each week's rows by the time field `at` names.
  const weekly = <T>(items: T[], at: (item: T) => string): T[][] =>
    Array.from({ length: 8 }, (_, i) => {
      const from = since(end, (8 - i) * 7);
      const to = since(end, (7 - i) * 7);
      return items.filter((r) => at(r) >= from && at(r) < to);
    });
  const done = rows.finished.filter((r) => r.status === "done");
  const byWeek = weekly(done, (r) => r.updated_at).map((w) => w.length);
  const failedByWeek = weekly(rows.finished.filter((r) => r.status === "failed"), (r) => r.updated_at).map((w) => w.length);

  const outcomes30 = rows.outcomes.filter((o) => inWindow(o.recorded_at, 30));
  const outcomes90 = rows.outcomes.filter((o) => inWindow(o.recorded_at, 90));
  // As src/agent-record.ts reads them: only fields the Worker verified feed a rate.
  const mergeRows = outcomes90.filter((o) => {
    const v = verifiedFields(o.verified);
    return v.prs_opened === true && v.prs_merged === true;
  });
  const opened = mergeRows.reduce((t, o) => t + (o.prs_opened ?? 0), 0);
  const merged = mergeRows.reduce((t, o) => t + (o.prs_merged ?? 0), 0);
  const ciRows = outcomes90.filter((o) => verifiedFields(o.verified).ci_green === true && o.ci_green !== null);

  const agreement = (evaluations: StatsRows["evaluations"]) => {
    const agree = evaluations.filter((e) => e.agreement === "agree").length;
    return rate(agree, agree + evaluations.filter((e) => e.agreement === "disagree").length);
  };
  const waits30 = rows.waits.filter((w) => inWindow(w.at, 30));

  let up = 0;
  let down = 0;
  for (const ring of rows.rings) {
    for (const c of ring) {
      if (c === "1") up++;
      else if (c === "0") down++;
    }
  }

  const openOf = (status: string) => rows.open.filter((r) => r.status === status).reduce((t, r) => t + r.n, 0);
  const sha = rows.sha && /^[0-9a-f]{7,40}$/.test(rows.sha) ? rows.sha.slice(0, 7) : "unknown";

  return {
    version: 1,
    as_of: endIso.slice(0, 10),
    jobs: {
      completed_7d: done.filter((r) => inWindow(r.updated_at, 7)).length,
      completed_30d: done.filter((r) => inWindow(r.updated_at, 30)).length,
      failed_30d: rows.finished.filter((r) => r.status === "failed" && inWindow(r.updated_at, 30)).length,
      completed_by_week: byWeek,
      failed_by_week: failedByWeek,
      open: openOf("queued") + openOf("claimed") + openOf("blocked"),
      blocked: openOf("blocked"),
      median_duration_minutes_30d: median(outcomes30.map((o) => o.duration_minutes).filter((d): d is number => typeof d === "number")),
    },
    verification: {
      evaluations_90d: rows.evaluations.length,
      agreement_rate_90d: agreement(rows.evaluations),
      pr_merge_rate_90d: rate(merged, opened),
      ci_green_rate_90d: rate(ciRows.filter((o) => o.ci_green === 1).length, ciRows.length),
      agreement_by_week: weekly(rows.evaluations, (e) => e.recorded_at).map(agreement),
    },
    gates: {
      waits_30d: waits30.length,
      median_wait_minutes_30d: median(waits30.map((w) => w.waited_ms / MINUTE_MS)),
      share_ended_by_policy_30d: rate(waits30.filter((w) => w.actor_kind === "policy").length, waits30.length),
      waits_by_week: weekly(rows.waits, (w) => w.at).map((w) => w.length),
    },
    sites: { watched: rows.rings.length, uptime_7d: rate(up, up + down), slots_measured_7d: up + down },
    store: { documents: rows.documents, namespaces: rows.namespaces },
    systems: rows.systems,
    capsid: { sha7: sha },
  };
}

/** Reads the rows for summarize. Single-table reads, each bounded by its window. */
export async function readStatsRows(env: Env, now: Date, systems: StatsRows["systems"]): Promise<StatsRows> {
  const end = windowEnd(now);
  const endIso = end.toISOString();
  const db = env.DB;
  const finished = await db
    .prepare("SELECT status, updated_at FROM jobs WHERE status IN ('done', 'failed') AND updated_at >= ?1 AND updated_at < ?2")
    .bind(since(end, 56), endIso)
    .all<StatsRows["finished"][number]>();
  const open = await db
    .prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'claimed', 'blocked') GROUP BY status")
    .all<StatsRows["open"][number]>();
  const outcomes = await db
    .prepare("SELECT recorded_at, duration_minutes, prs_opened, prs_merged, ci_green, verified FROM job_outcomes WHERE recorded_at >= ?1 AND recorded_at < ?2")
    .bind(since(end, 90), endIso)
    .all<StatsRows["outcomes"][number]>();
  const evaluations = await db
    .prepare("SELECT agreement, recorded_at FROM job_evaluations WHERE recorded_at >= ?1 AND recorded_at < ?2")
    .bind(since(end, 90), endIso)
    .all<StatsRows["evaluations"][number]>();
  const waits = await db
    .prepare("SELECT actor_kind, waited_ms, at FROM job_touches WHERE waited_ms IS NOT NULL AND at >= ?1 AND at < ?2")
    .bind(since(end, 56), endIso)
    .all<StatsRows["waits"][number]>();
  const documents = await db.prepare("SELECT COUNT(*) AS n FROM documents").first<{ n: number }>();
  const namespaces = await db.prepare("SELECT COUNT(*) AS n FROM namespaces").first<{ n: number }>();
  const snapshot = await readSnapshot(env);
  return {
    finished: finished.results ?? [],
    open: open.results ?? [],
    outcomes: outcomes.results ?? [],
    evaluations: evaluations.results ?? [],
    waits: waits.results ?? [],
    rings: (snapshot?.sites ?? []).map((s) => s.ring),
    documents: documents?.n ?? 0,
    namespaces: namespaces?.n ?? 0,
    systems,
    sha: env.BUILD_SHA,
  };
}
