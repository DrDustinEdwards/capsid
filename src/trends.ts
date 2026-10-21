import { COMPLETE_MARKER, DEFAULT_RETENTION } from "@dustinedwards/d1-dump";
import { AUTO_MERGED_APPROVAL_REASON } from "./approval-executor";
import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { APP_ROSTER } from "./roster";
import { logEvent } from "./log";
import type { TrendBackupSlot, TrendCiDay, TrendCiRepo, TrendCostWeek, TrendMergeWeek, TrendMinutesWeek, TrendQueueDay, PortalTrends } from "./ops-types/views";
import { MINUTE_MS, DAY_MS } from "./time";

// The series behind the Portal's charts (docs/design/design-portal-evaluation.md section 3,
// ruled 2026-10-09: DECIDE 5, the trends route, and DECIDE 6, all eleven visuals). The feed
// carries no series longer than 7 days, so these are read on demand by GET
// /portal/api/trends (src/portal-trends.ts), read-only:
//
//   minutes    visual 1: minutes of Dustin per week, an estimate, and his decisions
//   queue      visual 3: per day, jobs posted, jobs ended, and jobs open at the day's end
//   merges     visual 7: per week, merged by the policy, by an approval, by the seat, closed;
//              and each rollback as an event
//   cost       visual 6: per week, model spend of the jobs that ended, against the cap in the feed
//   backups    visual 10: the retention slots, 14 daily, 8 weekly, 6 monthly, filled or not
//   ci         visual 11: per roster repo and day, the default branch green, red or not run
//
// Visuals 2 and 5 (waits, claim agreement) come from GET /portal/api/claims, which already
// serves them; 4, 8 and 9 from the plan and the feed. Every time here is UTC.

const TRENDS_QUEUE_DAYS = 14;
const TRENDS_CI_DAYS = 14;
// A human's activity rows read for the minutes, at most. Far above a real week's count;
// past it the series says it is cut rather than undercounting quietly. The newest rows
// are the ones kept, so a cut costs the oldest week, not this one.
const MINUTES_ROW_CAP = 20_000;
// A gap longer than this starts a new session (the experience review's section 8).
const SESSION_GAP_MS = 5 * MINUTE_MS;
const CI_CACHE_KEY = "portal:trends-ci:v1";
const CI_CACHE_SECONDS = 60 * 60;
const BACKUP_PREFIX = "backups/json/";

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday (UTC) of the week a day falls in, as YYYY-MM-DD. */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return dayOf(t - dow * DAY_MS);
}

/** The ISO 8601 week label of a Monday, as "2026-W41". */
export function isoWeek(monday: string): string {
  const t = Date.parse(`${monday}T00:00:00Z`);
  // The ISO year is the year of the week's Thursday.
  const thursday = new Date(t + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const n = Math.round((t - week1) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(n).padStart(2, "0")}`;
}

/** The Mondays of the last `weeks` weeks, oldest first, ending with this week's. */
export function weekStarts(now: Date, weeks: number): string[] {
  const thisMonday = Date.parse(`${mondayOf(dayOf(now.getTime()))}T00:00:00Z`);
  return Array.from({ length: weeks }, (_, i) => dayOf(thisMonday - (weeks - 1 - i) * 7 * DAY_MS));
}

/** The last `days` days, oldest first, ending today. */
export function lastDays(now: Date, days: number): string[] {
  const today = Date.parse(`${dayOf(now.getTime())}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => dayOf(today - (days - 1 - i) * DAY_MS));
}

/** An audit or touch time to milliseconds. Both "YYYY-MM-DD HH:MM:SS" (SQLite's
 *  datetime('now'), no zone) and ISO are written; both are UTC. */
export function timeMs(at: string): number {
  return Date.parse(at.includes("T") ? (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`) : `${at.replace(" ", "T")}Z`);
}

/** Minutes and sessions per week from activity times: a session ends after a gap over
 *  five minutes and counts its span plus one minute, so a single click is a minute. A
 *  session is credited to the week it starts in. */
export function sessionMinutes(times: number[], mondays: string[]): Map<string, { minutes: number; sessions: number }> {
  const out = new Map(mondays.map((m) => [m, { minutes: 0, sessions: 0 }]));
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1]! - end <= SESSION_GAP_MS) end = sorted[++i]!;
    i++;
    const week = out.get(mondayOf(dayOf(start)));
    if (!week) continue;
    week.sessions += 1;
    week.minutes += (end - start) / MINUTE_MS + 1;
  }
  for (const w of out.values()) w.minutes = Math.round(w.minutes);
  return out;
}

async function readMinutes(db: D1Database, mondays: string[]): Promise<{ weeks: TrendMinutesWeek[]; truncated: boolean }> {
  const from = `${mondays[0]} 00:00:00`;
  const [audit, touches, decisions, approvals] = await Promise.all([
    // A write by the administrator's own login. The Portal's reads are not audited, so
    // looking without acting is not counted: the figure is a floor, and says so.
    db
      .prepare("SELECT at FROM audit_log WHERE at >= ?1 AND actor LIKE 'access:%' ORDER BY at DESC LIMIT ?2")
      .bind(from, MINUTES_ROW_CAP + 1)
      .all<{ at: string }>(),
    db
      .prepare("SELECT at FROM job_touches WHERE at >= ?1 AND actor_kind = 'human' ORDER BY at DESC LIMIT ?2")
      .bind(mondays[0], MINUTES_ROW_CAP + 1)
      .all<{ at: string }>(),
    // A decision is a human touch that ended a wait or closed a job, not a note.
    db
      .prepare(
        "SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM job_touches WHERE at >= ?1 AND actor_kind = 'human' AND kind <> 'note' GROUP BY day"
      )
      .bind(mondays[0])
      .all<{ day: string; n: number }>(),
    db
      .prepare("SELECT substr(approved_at, 1, 10) AS day, COUNT(*) AS n FROM pr_approvals WHERE approved_at >= ?1 AND approved_by LIKE 'access:%' GROUP BY day")
      .bind(mondays[0])
      .all<{ day: string; n: number }>(),
  ]);
  const truncated = audit.results.length > MINUTES_ROW_CAP || touches.results.length > MINUTES_ROW_CAP;
  const times = [...audit.results.slice(0, MINUTES_ROW_CAP), ...touches.results.slice(0, MINUTES_ROW_CAP)].map((r) => timeMs(r.at));
  const minutes = sessionMinutes(times, mondays);
  const perWeek = new Map(mondays.map((m) => [m, 0]));
  for (const r of [...decisions.results, ...approvals.results]) {
    const m = mondayOf(r.day);
    if (perWeek.has(m)) perWeek.set(m, perWeek.get(m)! + r.n);
  }
  return {
    weeks: mondays.map((m) => ({ week: isoWeek(m), start: m, minutes: minutes.get(m)!.minutes, sessions: minutes.get(m)!.sessions, decisions: perWeek.get(m)! })),
    truncated,
  };
}

async function readQueue(db: D1Database, days: string[]): Promise<TrendQueueDay[]> {
  const from = days[0]!;
  const [before, posted, ended] = await Promise.all([
    // Open when the window starts: posted before it and not yet ended by then. A job
    // that ended (done, failed, superseded) never moves again, so its updated_at is when.
    db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE created_at < ?1 AND NOT (status IN ('done', 'failed', 'superseded') AND updated_at < ?1)")
      .bind(from)
      .first<{ n: number }>(),
    db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM jobs WHERE created_at >= ?1 GROUP BY day").bind(from).all<{ day: string; n: number }>(),
    db
      .prepare("SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS n FROM jobs WHERE status IN ('done', 'failed', 'superseded') AND updated_at >= ?1 GROUP BY day")
      .bind(from)
      .all<{ day: string; n: number }>(),
  ]);
  const p = new Map(posted.results.map((r) => [r.day, r.n]));
  const e = new Map(ended.results.map((r) => [r.day, r.n]));
  let open = before?.n ?? 0;
  return days.map((day) => {
    const row = { day, posted: p.get(day) ?? 0, ended: e.get(day) ?? 0, open: 0 };
    open += row.posted - row.ended;
    row.open = open;
    return row;
  });
}

async function readMerges(db: D1Database, mondays: string[]): Promise<{ weeks: TrendMergeWeek[]; rollbacks: PortalTrends["merges"]["rollbacks"] }> {
  const from = `${mondays[0]} 00:00:00`;
  const [rows, rollbacks] = await Promise.all([
    // auto-merged: the policy merged on its own (src/auto-merge-tick.ts). approved-merged:
    // the executor merged an approval (src/approval-executor.ts). manage_pr: the seat's
    // own merge or close through capsid_close_pr. pr-closed: a close from the Portal. A
    // policy merge of a pull request that held an approval also closes the approval with an
    // approved-merged row (closeAsAutoMerged); that row is the same merge, so it is skipped.
    db
      .prepare(
        `SELECT substr(at, 1, 10) AS day,
                CASE WHEN action = 'auto-merged' THEN 'auto'
                     WHEN action = 'approved-merged' THEN 'approved'
                     WHEN action = 'pr-closed' THEN 'closed'
                     WHEN params LIKE '%"action":"close"%' THEN 'closed'
                     ELSE 'seat' END AS kind,
                COUNT(*) AS n
         FROM audit_log
         WHERE at >= ?1
           AND (action IN ('auto-merged', 'approved-merged', 'pr-closed')
                OR (action = 'manage_pr' AND (params LIKE '%"merged":true%' OR params LIKE '%"action":"close"%')))
           AND NOT (action = 'approved-merged' AND instr(COALESCE(params, ''), ?2) > 0)
         GROUP BY day, kind`
      )
      // instr, not LIKE: D1 refuses a LIKE pattern this long.
      .bind(from, `"reason":${JSON.stringify(AUTO_MERGED_APPROVAL_REASON)}`)
      .all<{ day: string; kind: "auto" | "approved" | "seat" | "closed"; n: number }>(),
    db
      .prepare("SELECT repo, pr, run_at, outcome FROM deploy_outcomes WHERE run_at >= ?1 AND outcome IN ('rolled_back', 'rollback_failed') ORDER BY run_at")
      .bind(mondays[0])
      .all<{ repo: string; pr: number | null; run_at: string; outcome: "rolled_back" | "rollback_failed" }>(),
  ]);
  const weeks = new Map<string, TrendMergeWeek>(mondays.map((m) => [m, { week: isoWeek(m), start: m, auto: 0, approved: 0, seat: 0, closed: 0 }]));
  for (const r of rows.results) {
    const w = weeks.get(mondayOf(r.day));
    if (w) w[r.kind] += r.n;
  }
  return { weeks: [...weeks.values()], rollbacks: rollbacks.results.map((r) => ({ at: r.run_at, repo: r.repo, pr: r.pr, outcome: r.outcome })) };
}

/** Model spend per week from outcome rows summed by day (cost_usd, rows that carried one).
 *  A week with no costed outcome is null, never 0: no telemetry is not a free week. */
export function costWeeks(rows: Array<{ day: string; usd: number; n: number }>, mondays: string[]): TrendCostWeek[] {
  const weeks = new Map<string, { usd: number; jobs: number }>(mondays.map((m) => [m, { usd: 0, jobs: 0 }]));
  for (const r of rows) {
    const w = weeks.get(mondayOf(r.day));
    if (!w) continue;
    w.usd += r.usd;
    w.jobs += r.n;
  }
  return mondays.map((m) => {
    const w = weeks.get(m)!;
    return { week: isoWeek(m), start: m, usd: w.jobs ? Math.round(w.usd * 100) / 100 : null, jobs: w.jobs };
  });
}

async function readCost(db: D1Database, mondays: string[]): Promise<TrendCostWeek[]> {
  const rows = await db
    .prepare("SELECT substr(recorded_at, 1, 10) AS day, SUM(cost_usd) AS usd, COUNT(cost_usd) AS n FROM job_outcomes WHERE recorded_at >= ?1 AND cost_usd IS NOT NULL GROUP BY day")
    .bind(mondays[0])
    .all<{ day: string; usd: number; n: number }>();
  return costWeeks(rows.results, mondays);
}

/** The retention slots d1-dump keeps (14 daily, 8 weekly, 6 monthly), each filled when a
 *  complete run falls in it. Run ids begin with their ISO day. */
export function backupSlots(completeRunIds: string[], now: Date): NonNullable<PortalTrends["backups"]["slots"]> {
  const days = new Set(completeRunIds.map((id) => id.slice(0, 10)));
  const weeks = new Set([...days].map(mondayOf));
  const months = new Set([...days].map((d) => d.slice(0, 7)));
  const { daily: nDaily, weekly: nWeekly, monthly: nMonthly } = DEFAULT_RETENTION;
  const daily: TrendBackupSlot[] = lastDays(now, nDaily).map((key) => ({ key, filled: days.has(key) }));
  const weekly: TrendBackupSlot[] = weekStarts(now, nWeekly).map((key) => ({ key, filled: weeks.has(key) }));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthly: TrendBackupSlot[] = Array.from({ length: nMonthly }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (nMonthly - 1 - i), 1));
    const key = d.toISOString().slice(0, 7);
    return { key, filled: months.has(key) };
  });
  return { daily, weekly, monthly };
}

async function readBackups(env: Env, now: Date): Promise<PortalTrends["backups"]> {
  try {
    const complete: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix: BACKUP_PREFIX, cursor });
      for (const o of page.objects) {
        if (o.key.endsWith(`/${COMPLETE_MARKER}`)) complete.push(o.key.slice(BACKUP_PREFIX.length).split("/")[0]!);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { slots: backupSlots(complete, now), runs: complete.length, error: null };
  } catch (err) {
    return { slots: null, runs: null, error: `The backup bucket could not be listed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface RunLite {
  conclusion: string | null;
  status: string;
  created_at: string;
  // Each workflow keeps its own verdict, so a green run of one workflow does not hide
  // another that is red. Absent, every run counts as one workflow.
  workflow_id?: number;
}

/** A repo's default branch per day: "red" when any workflow's last completed run up to
 *  the day's end failed, "green" when every one passed, carried forward over a day with
 *  none, and "none" before the first run seen. */
export function ciDays(runs: RunLite[], days: string[]): TrendCiDay[] {
  const done = runs.filter((r) => r.status === "completed" && r.conclusion !== null && !["cancelled", "skipped", "neutral"].includes(r.conclusion));
  const byDay = new Map<string, RunLite[]>();
  for (const r of done) {
    const d = r.created_at.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const latest = new Map<number | undefined, boolean>();
  return days.map((day) => {
    const list = (byDay.get(day) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const failed = list.filter((r) => r.conclusion !== "success").length;
    for (const r of list) latest.set(r.workflow_id, r.conclusion === "success");
    const state: TrendCiDay["state"] = latest.size === 0 ? "none" : [...latest.values()].every(Boolean) ? "green" : "red";
    return { day, runs: list.length, failed, state };
  });
}

async function readCiRepo(env: Env, namespace: string, days: string[]): Promise<TrendCiRepo> {
  const { owner, repo, full } = await resolveRepo(env, namespace);
  const branch = await getDefaultBranch(env, owner, repo);
  const query = `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&created=${encodeURIComponent(`>=${days[0]}`)}&per_page=100&exclude_pull_requests=true`;
  const resp = await ghFetch(env, owner, repo, query);
  if (!resp.ok) throw new Error(`GitHub answered ${resp.status} for ${full}'s runs`);
  const data = (await resp.json()) as { workflow_runs: RunLite[]; total_count: number };
  return { namespace, repo: full, days: ciDays(data.workflow_runs, days), truncated: data.total_count > data.workflow_runs.length };
}

async function readCi(env: Env, now: Date): Promise<PortalTrends["ci"]> {
  const days = lastDays(now, TRENDS_CI_DAYS);
  try {
    const cached = await env.APP_KV.get(CI_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as PortalTrends["ci"];
      if (parsed.repos.every((r) => r.days.length === days.length && r.days[r.days.length - 1]?.day === days[days.length - 1])) return parsed;
    }
  } catch (err) {
    // An unreadable cache entry is read again from GitHub below.
    logEvent("warn", "TRENDS_CI_CACHE_UNREADABLE", { message: `TRENDS_CI_CACHE_UNREADABLE ${CI_CACHE_KEY}: ${err instanceof Error ? err.message : String(err)}` });
  }
  const repos: TrendCiRepo[] = [];
  const notRead: Array<{ namespace: string; error: string }> = [];
  const settled = await Promise.allSettled(APP_ROSTER.map((namespace) => readCiRepo(env, namespace, days)));
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") repos.push(r.value);
    else notRead.push({ namespace: APP_ROSTER[i]!, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  const out: PortalTrends["ci"] = { read_at: now.toISOString(), repos, not_read: notRead };
  // Only a full read is kept, so a GitHub outage is retried on the next look, not for an hour.
  // A failed cache write costs only the next look a fresh read, so it does not fail this one.
  if (!notRead.length) {
    try {
      await env.APP_KV.put(CI_CACHE_KEY, JSON.stringify(out), { expirationTtl: CI_CACHE_SECONDS });
    } catch (err) {
      logEvent("warn", "TRENDS_CI_CACHE_WRITE_FAILED", { message: `TRENDS_CI_CACHE_WRITE_FAILED ${CI_CACHE_KEY}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

/** Every series, for `weeks` weeks of the weekly ones. */
export async function readTrends(env: Env, now: Date, weeks: number): Promise<PortalTrends> {
  const mondays = weekStarts(now, weeks);
  const [minutes, queue, merges, cost, backups, ci] = await Promise.all([
    readMinutes(env.DB, mondays),
    readQueue(env.DB, lastDays(now, TRENDS_QUEUE_DAYS)),
    readMerges(env.DB, mondays),
    readCost(env.DB, mondays),
    readBackups(env, now),
    readCi(env, now),
  ]);
  return {
    generated: now.toISOString(),
    weeks,
    minutes: {
      weeks: minutes.weeks,
      truncated: minutes.truncated,
      note: "An estimate: the administrator's own writes and job touches, sessions split at a 5-minute gap, plus 1 minute each. Reading the Portal without acting is not counted.",
    },
    queue,
    merges,
    cost: { weeks: cost },
    backups,
    ci,
  };
}
