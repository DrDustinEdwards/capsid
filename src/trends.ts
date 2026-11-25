import { median } from "capsomer/behavior/format";
import { lastDays, mondayOf, weekStarts } from "./trends-days";
import { readBackups, readCi } from "./trends-outside";
import { AUTO_MERGED_APPROVAL_REASON } from "./approval-executor";
import type { Env } from "./env";
import type {
  TrendDeployRepo,
  TrendMergeWeek,
  TrendMinutesWeek,
  TrendQueueDay,
  PortalTrends,
} from "./ops-types/views";
import { MINUTE_MS, isoWeek, timeMs, utcDay } from "./time";

// The series behind the Portal's charts (docs/design/design-portal-evaluation.md section 3): the feed carries nothing
// longer than 7 days, so GET /portal/api/trends (src/portal-trends.ts) reads them on demand. Visuals 2 and 5 come from
// /portal/api/claims; 4, 8 and 9 from the plan and the feed. Every time is UTC.

const TRENDS_QUEUE_DAYS = 14;
// At most this many activity rows; past it the series says it is cut. Newest are kept, so a cut costs the oldest week.
const MINUTES_ROW_CAP = 20_000;
const SESSION_GAP_MS = 5 * MINUTE_MS;

// A session ends after a gap over five minutes and counts its span plus one minute, credited to its start week.
export function sessionMinutes(
  times: number[],
  mondays: string[],
): Map<string, { minutes: number; sessions: number }> {
  const out = new Map(mondays.map((m) => [m, { minutes: 0, sessions: 0 }]));
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1]! - end <= SESSION_GAP_MS) end = sorted[++i]!;
    i++;
    const week = out.get(mondayOf(utcDay(new Date(start))));
    if (!week) continue;
    week.sessions += 1;
    week.minutes += (end - start) / MINUTE_MS + 1;
  }
  for (const w of out.values()) w.minutes = Math.round(w.minutes);
  return out;
}

async function readMinutes(
  db: D1Database,
  mondays: string[],
): Promise<{ weeks: TrendMinutesWeek[]; truncated: boolean }> {
  const from = `${mondays[0]} 00:00:00`;
  const [audit, touches, decisions, approvals] = await Promise.all([
    // A write by the administrator's login; the Portal's reads are not audited, so the figure is a floor.
    db
      .prepare(
        "SELECT at FROM audit_log WHERE at >= ?1 AND actor LIKE 'access:%' ORDER BY at DESC LIMIT ?2",
      )
      .bind(from, MINUTES_ROW_CAP + 1)
      .all<{ at: string }>(),
    db
      .prepare(
        "SELECT at FROM job_touches WHERE at >= ?1 AND actor_kind = 'human' ORDER BY at DESC LIMIT ?2",
      )
      .bind(mondays[0], MINUTES_ROW_CAP + 1)
      .all<{ at: string }>(),
    db
      .prepare(
        "SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM job_touches WHERE at >= ?1 AND actor_kind = 'human' AND kind <> 'note' GROUP BY day",
      )
      .bind(mondays[0])
      .all<{ day: string; n: number }>(),
    db
      .prepare(
        "SELECT substr(approved_at, 1, 10) AS day, COUNT(*) AS n FROM pr_approvals WHERE approved_at >= ?1 AND approved_by LIKE 'access:%' GROUP BY day",
      )
      .bind(mondays[0])
      .all<{ day: string; n: number }>(),
  ]);
  const truncated =
    audit.results.length > MINUTES_ROW_CAP || touches.results.length > MINUTES_ROW_CAP;
  const times = [
    ...audit.results.slice(0, MINUTES_ROW_CAP),
    ...touches.results.slice(0, MINUTES_ROW_CAP),
  ].map((r) => timeMs(r.at));
  const minutes = sessionMinutes(times, mondays);
  const perWeek = new Map(mondays.map((m) => [m, 0]));
  for (const r of [...decisions.results, ...approvals.results]) {
    const m = mondayOf(r.day);
    if (perWeek.has(m)) perWeek.set(m, perWeek.get(m)! + r.n);
  }
  return {
    weeks: mondays.map((m) => ({
      week: isoWeek(new Date(`${m}T00:00:00Z`)),
      start: m,
      minutes: minutes.get(m)!.minutes,
      sessions: minutes.get(m)!.sessions,
      decisions: perWeek.get(m)!,
    })),
    truncated,
  };
}

async function readQueue(db: D1Database, days: string[]): Promise<TrendQueueDay[]> {
  const from = days[0]!;
  const [before, posted, ended] = await Promise.all([
    // Open at window start: posted before and not yet ended. Ended jobs never move again, so updated_at is when.
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE created_at < ?1 AND NOT (status IN ('done', 'failed', 'superseded') AND updated_at < ?1)",
      )
      .bind(from)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM jobs WHERE created_at >= ?1 GROUP BY day",
      )
      .bind(from)
      .all<{ day: string; n: number }>(),
    db
      .prepare(
        "SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS n FROM jobs WHERE status IN ('done', 'failed', 'superseded') AND updated_at >= ?1 GROUP BY day",
      )
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

async function readMerges(
  db: D1Database,
  mondays: string[],
): Promise<{ weeks: TrendMergeWeek[]; rollbacks: PortalTrends["merges"]["rollbacks"] }> {
  const from = `${mondays[0]} 00:00:00`;
  const [rows, rollbacks] = await Promise.all([
    // auto-merged is the policy (src/auto-merge-tick.ts), approved-merged the executor (src/approval-executor.ts), manage_pr the seat,
    // pr-closed the Portal. A policy merge also closes its approval with an approved-merged row (closeAsAutoMerged): same merge, skipped.
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
         GROUP BY day, kind`,
      )
      .bind(from, `"reason":${JSON.stringify(AUTO_MERGED_APPROVAL_REASON)}`)
      .all<{ day: string; kind: "auto" | "approved" | "seat" | "closed"; n: number }>(),
    db
      .prepare(
        "SELECT repo, pr, run_at, outcome FROM deploy_outcomes WHERE run_at >= ?1 AND outcome IN ('rolled_back', 'rollback_failed') ORDER BY run_at",
      )
      .bind(mondays[0])
      .all<{
        repo: string;
        pr: number | null;
        run_at: string;
        outcome: "rolled_back" | "rollback_failed";
      }>(),
  ]);
  const weeks = new Map<string, TrendMergeWeek>(
    mondays.map((m) => [
      m,
      {
        week: isoWeek(new Date(`${m}T00:00:00Z`)),
        start: m,
        auto: 0,
        approved: 0,
        seat: 0,
        closed: 0,
      },
    ]),
  );
  for (const r of rows.results) {
    const w = weeks.get(mondayOf(r.day));
    if (w) w[r.kind] += r.n;
  }
  return {
    weeks: [...weeks.values()],
    rollbacks: rollbacks.results.map((r) => ({
      at: r.run_at,
      repo: r.repo,
      pr: r.pr,
      outcome: r.outcome,
    })),
  };
}

type DeployOutcomeName =
  | "verified"
  | "rolled_back"
  | "rollback_failed"
  | "rollback_skipped"
  | "unverified";

// DORA measures per repository (checklist F4) from deploy_outcomes. An "unverified" gate (could not run) is counted
// apart: it neither shipped nor failed as far as anyone knows.
function deployStats(
  rows: ReadonlyArray<{ repo: string; outcome: DeployOutcomeName; restore_seconds: number | null }>,
  weeks: number,
): TrendDeployRepo[] {
  const by = new Map<
    string,
    {
      shipped: number;
      refused: number;
      rolled_back: number;
      unverified: number;
      restores: number[];
    }
  >();
  for (const r of rows) {
    const t = by.get(r.repo) ?? {
      shipped: 0,
      refused: 0,
      rolled_back: 0,
      unverified: 0,
      restores: [],
    };
    by.set(r.repo, t);
    if (r.outcome === "verified") t.shipped++;
    else if (r.outcome === "unverified") t.unverified++;
    else {
      t.refused++;
      if (r.outcome === "rolled_back") t.rolled_back++;
      if (r.outcome === "rolled_back" && r.restore_seconds !== null)
        t.restores.push(r.restore_seconds);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, t]) => {
      const decided = t.shipped + t.refused;
      const restoreMedian = median(t.restores, { round: true });
      return {
        repo,
        deploys: decided + t.unverified,
        per_week: Math.round(((decided + t.unverified) / weeks) * 10) / 10,
        shipped: t.shipped,
        refused: t.refused,
        rolled_back: t.rolled_back,
        unverified: t.unverified,
        change_failure_rate: decided ? Math.round((t.refused / decided) * 1000) / 1000 : null,
        restore_median_seconds: restoreMedian,
      };
    });
}

async function readDeploys(db: D1Database, mondays: string[]): Promise<TrendDeployRepo[]> {
  const rows = await db
    .prepare("SELECT repo, outcome, restore_seconds FROM deploy_outcomes WHERE run_at >= ?1")
    .bind(mondays[0])
    .all<{ repo: string; outcome: DeployOutcomeName; restore_seconds: number | null }>();
  return deployStats(rows.results, mondays.length);
}

export async function readTrends(env: Env, now: Date, weeks: number): Promise<PortalTrends> {
  const mondays = weekStarts(now, weeks);
  const [minutes, queue, merges, deploys, backups, ci] = await Promise.all([
    readMinutes(env.DB, mondays),
    readQueue(env.DB, lastDays(now, TRENDS_QUEUE_DAYS)),
    readMerges(env.DB, mondays),
    readDeploys(env.DB, mondays),
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
    deploys: { repos: deploys },
    backups,
    ci,
  };
}
