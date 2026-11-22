import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import { COMPLETE_MARKER } from "@dustinedwards/d1-dump";
import { DUMP_RETENTION } from "./backup";
import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { APP_ROSTER } from "./roster";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import type { TrendBackupSlot, TrendCiDay, TrendCiRepo, PortalTrends } from "./ops-types/views";

import { lastDays, mondayOf, weekStarts } from "./trends-days";

// The trends' two reads that come from outside D1: the backup retention slots (visual 10)
// and the default branch's CI by day (visual 11). The rest of the series is src/trends.ts.

const TRENDS_CI_DAYS = 14;
const CI_CACHE_KEY = "portal:trends-ci:v1";
const CI_CACHE_SECONDS = 60 * 60;
const BACKUP_PREFIX = "backups/json/";

/** The retention slots d1-dump keeps (14 daily, 4 weekly, 3 monthly), each filled when a
 *  complete run falls in it. Run ids begin with their ISO day. */
export function backupSlots(
  completeRunIds: string[],
  now: Date,
): NonNullable<PortalTrends["backups"]["slots"]> {
  const days = new Set(completeRunIds.map((id) => id.slice(0, 10)));
  const weeks = new Set([...days].map(mondayOf));
  const months = new Set([...days].map((d) => d.slice(0, 7)));
  const { daily: nDaily, weekly: nWeekly, monthly: nMonthly } = DUMP_RETENTION;
  const daily: TrendBackupSlot[] = lastDays(now, nDaily).map((key) => ({
    key,
    filled: days.has(key),
  }));
  const weekly: TrendBackupSlot[] = weekStarts(now, nWeekly).map((key) => ({
    key,
    filled: weeks.has(key),
  }));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthly: TrendBackupSlot[] = Array.from({ length: nMonthly }, (_, i) => {
    const d = new Date(Date.UTC(y, m - (nMonthly - 1 - i), 1));
    const key = d.toISOString().slice(0, 7);
    return { key, filled: months.has(key) };
  });
  return { daily, weekly, monthly };
}

export async function readBackups(env: Env, now: Date): Promise<PortalTrends["backups"]> {
  try {
    const complete: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix: BACKUP_PREFIX, cursor });
      for (const o of page.objects) {
        if (o.key.endsWith(`/${COMPLETE_MARKER}`))
          complete.push(o.key.slice(BACKUP_PREFIX.length).split("/")[0]!);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { slots: backupSlots(complete, now), runs: complete.length, error: null };
  } catch (err) {
    return {
      slots: null,
      runs: null,
      error: `The backup bucket could not be listed: ${errorMessage(err)}`,
    };
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
  const done = runs.filter(
    (r) =>
      r.status === "completed" &&
      r.conclusion !== null &&
      !["cancelled", "skipped", "neutral"].includes(r.conclusion),
  );
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
    const state: TrendCiDay["state"] =
      latest.size === 0 ? "none" : [...latest.values()].every(Boolean) ? "green" : "red";
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
  return {
    namespace,
    repo: full,
    days: ciDays(data.workflow_runs, days),
    truncated: data.total_count > data.workflow_runs.length,
  };
}

export async function readCi(env: Env, now: Date): Promise<PortalTrends["ci"]> {
  const days = lastDays(now, TRENDS_CI_DAYS);
  // A kept read is served only while it covers the same days; only a full read is kept, so a
  // GitHub outage is retried on the next look, not for an hour.
  return kvCached(
    env.APP_KV,
    CI_CACHE_KEY,
    {
      ttl: CI_CACHE_SECONDS,
      valid: (kept) => coversDays(kept, days),
      keep: (out) => out.not_read.length === 0,
    },
    () => readCiFresh(env, now, days),
  );
}

function coversDays(kept: unknown, days: string[]): boolean {
  const repos = (kept as Partial<PortalTrends["ci"]> | null)?.repos;
  return (
    Array.isArray(repos) &&
    repos.every(
      (r) =>
        r.days.length === days.length && r.days[r.days.length - 1]?.day === days[days.length - 1],
    )
  );
}

async function readCiFresh(env: Env, now: Date, days: string[]): Promise<PortalTrends["ci"]> {
  const repos: TrendCiRepo[] = [];
  const notRead: Array<{ namespace: string; error: string }> = [];
  const settled = await Promise.allSettled(
    APP_ROSTER.map((namespace) => readCiRepo(env, namespace, days)),
  );
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") repos.push(r.value);
    else
      notRead.push({
        namespace: APP_ROSTER[i]!,
        error: errorMessage(r.reason),
      });
  });
  return { read_at: now.toISOString(), repos, not_read: notRead };
}
