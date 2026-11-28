import { median } from "capsomer/behavior/format";
import { mondayOf, weekStarts } from "./trends-days";
import { readBackups, readCi } from "./trends-outside";
import type { Env } from "./env";
import type { TrendDeployRepo, TrendMinutesWeek, PortalTrends } from "./ops-types/views";
import { MINUTE_MS, isoWeek, timeMs, utcDay } from "./time";

// The series behind the Portal's charts: the feed carries nothing
// longer than 7 days, so GET /portal/api/trends (src/portal-trends.ts) reads them on demand. Every time is UTC.

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
  // A write by the administrator's login; the Portal's reads are not audited, so the figure is a floor.
  const audit = await db
    .prepare(
      "SELECT at FROM audit_log WHERE at >= ?1 AND actor LIKE 'access:%' ORDER BY at DESC LIMIT ?2",
    )
    .bind(from, MINUTES_ROW_CAP + 1)
    .all<{ at: string }>();
  const truncated = audit.results.length > MINUTES_ROW_CAP;
  const times = audit.results.slice(0, MINUTES_ROW_CAP).map((r) => timeMs(r.at));
  const minutes = sessionMinutes(times, mondays);
  return {
    weeks: mondays.map((m) => ({
      week: isoWeek(new Date(`${m}T00:00:00Z`)),
      start: m,
      minutes: minutes.get(m)!.minutes,
      sessions: minutes.get(m)!.sessions,
    })),
    truncated,
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
  const [minutes, deploys, backups, ci] = await Promise.all([
    readMinutes(env.DB, mondays),
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
      note: "An estimate: the administrator's own writes, sessions split at a 5-minute gap, plus 1 minute each. Reading the Portal without acting is not counted.",
    },
    deploys: { repos: deploys },
    backups,
    ci,
  };
}
