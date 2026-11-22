import type { Env } from "./env";
import type {
  DigestBlocked,
  DigestJob,
  DigestPr,
  OvernightDigest,
  UsageSource,
  UsageTotals,
} from "./ops-types/views";
import { PR_URL_SOURCE } from "@dustinedwards/site-runtime/github";
import { HOUR_MS } from "./time";

// THE MORNING DIGEST (src/overnight-plan.ts holds the plan; capsid/research/design-automation-for-speed.md, D2):
// pull requests ready, what blocked and why, and what each job cost, from the outcome row
// (telemetry) or the agent's own claim.usage, never summed.

const DIGEST_ROWS_MAX = 200;
const DIGEST_DEFAULT_HOURS = 24;
const SUMMARY_CHARS = 600;

const NO_USAGE: UsageTotals = {
  cost_usd: null,
  active_seconds: null,
  tokens_input: null,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_creation: null,
};

interface OutcomeRow {
  job_id: string;
  namespace: string;
  title: string | null;
  status: string | null;
  result_kind: string | null;
  duration_minutes: number | null;
  blocked_count: number | null;
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  active_seconds: number | null;
}

interface BlockedRow {
  id: string;
  namespace: string;
  title: string;
  result_summary: string | null;
  updated_at: string;
}

interface PrRow {
  job_id: string;
  namespace: string;
  pr_url: string;
  merged: number | null;
}

interface ReportedRow extends UsageTotals {
  job_id: string;
}

const PR_URL = new RegExp(PR_URL_SOURCE, "g");

export const pullRequestsIn = (text: string | null): string[] => [
  ...new Set(text?.match(PR_URL) ?? []),
];

const hasUsage = (u: UsageTotals): boolean => Object.values(u).some((v) => v !== null);

const sum = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

function addUsage(total: UsageTotals, u: UsageTotals): UsageTotals {
  return {
    cost_usd: sum(total.cost_usd, u.cost_usd),
    active_seconds: sum(total.active_seconds, u.active_seconds),
    tokens_input: sum(total.tokens_input, u.tokens_input),
    tokens_output: sum(total.tokens_output, u.tokens_output),
    tokens_cache_read: sum(total.tokens_cache_read, u.tokens_cache_read),
    tokens_cache_creation: sum(total.tokens_cache_creation, u.tokens_cache_creation),
  };
}

/** One job's usage: the telemetry on its outcome row if any, else what the agent reported, else none. */
export function chooseUsage(
  telemetry: UsageTotals,
  reported: UsageTotals | undefined,
): { usage: UsageTotals; source: UsageSource } {
  if (hasUsage(telemetry)) return { usage: telemetry, source: "telemetry" };
  if (reported && hasUsage(reported)) return { usage: reported, source: "reported" };
  return { usage: NO_USAGE, source: "none" };
}

export function digestSinceFrom(
  since: string | undefined,
  now: Date,
): { ok: true; since: string } | { ok: false; refusal: string } {
  if (since === undefined || since.trim() === "")
    return {
      ok: true,
      since: new Date(now.getTime() - DIGEST_DEFAULT_HOURS * HOUR_MS).toISOString(),
    };
  const parsed = Date.parse(since);
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(since) || Number.isNaN(parsed)) {
    return {
      ok: false,
      refusal: `since must be an ISO 8601 time such as 2026-10-04 or 2026-10-04T22:00:00Z; got '${since}'.`,
    };
  }
  return { ok: true, since: new Date(parsed).toISOString() };
}

export async function readOvernightDigest(
  env: Env,
  args: { namespace?: string; since: string },
  now: Date,
): Promise<OvernightDigest> {
  const ns = args.namespace ?? null;
  const bound = DIGEST_ROWS_MAX + 1;
  const [outcomes, blocked, prs, reported] = await Promise.all([
    env.DB.prepare(
      `SELECT o.job_id AS job_id, o.namespace AS namespace, j.title AS title, j.status AS status, o.result_kind AS result_kind,
         o.duration_minutes AS duration_minutes, o.blocked_count AS blocked_count, o.cost_usd AS cost_usd,
         o.tokens_input AS tokens_input, o.tokens_output AS tokens_output, o.tokens_cache_read AS tokens_cache_read,
         o.tokens_cache_creation AS tokens_cache_creation, o.active_seconds AS active_seconds
       FROM job_outcomes o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.recorded_at >= ?1 AND (?2 IS NULL OR o.namespace = ?2) ORDER BY o.recorded_at DESC LIMIT ?3`,
    )
      .bind(args.since, ns, bound)
      .all<OutcomeRow>(),
    env.DB.prepare(
      `SELECT id, namespace, title, result_summary, updated_at FROM jobs
       WHERE status = 'blocked' AND updated_at >= ?1 AND (?2 IS NULL OR namespace = ?2) ORDER BY updated_at DESC LIMIT ?3`,
    )
      .bind(args.since, ns, bound)
      .all<BlockedRow>(),
    env.DB.prepare(
      `SELECT p.job_id AS job_id, o.namespace AS namespace, p.pr_url AS pr_url, p.merged AS merged
       FROM job_outcome_prs p JOIN job_outcomes o ON o.job_id = p.job_id
       WHERE o.recorded_at >= ?1 AND (?2 IS NULL OR o.namespace = ?2) ORDER BY o.recorded_at DESC LIMIT ?3`,
    )
      .bind(args.since, ns, bound)
      .all<PrRow>(),
    // What each job's agent reported (claim.usage), summed per job. The job set is a
    // subquery on the same window, never a list of ids: D1 allows 100 bound parameters.
    env.DB.prepare(
      `SELECT job_id,
         SUM(json_extract(raw, '$.claim.usage.cost_usd')) AS cost_usd,
         SUM(json_extract(raw, '$.claim.usage.active_seconds')) AS active_seconds,
         SUM(json_extract(raw, '$.claim.usage.tokens.input')) AS tokens_input,
         SUM(json_extract(raw, '$.claim.usage.tokens.output')) AS tokens_output,
         SUM(json_extract(raw, '$.claim.usage.tokens.cache_read')) AS tokens_cache_read,
         SUM(json_extract(raw, '$.claim.usage.tokens.cache_creation')) AS tokens_cache_creation
       FROM job_claims
       WHERE json_extract(raw, '$.claim.usage') IS NOT NULL
         AND job_id IN (SELECT job_id FROM job_outcomes WHERE recorded_at >= ?1 AND (?2 IS NULL OR namespace = ?2)
                        UNION SELECT id FROM jobs WHERE status = 'blocked' AND updated_at >= ?1 AND (?2 IS NULL OR namespace = ?2))
       GROUP BY job_id LIMIT ?3`,
    )
      .bind(args.since, ns, bound)
      .all<ReportedRow>(),
  ]);

  const truncated: string[] = [];
  const within = <T>(name: string, rows: T[] | undefined): T[] => {
    const list = rows ?? [];
    if (list.length <= DIGEST_ROWS_MAX) return list;
    truncated.push(name);
    return list.slice(0, DIGEST_ROWS_MAX);
  };
  const reportedBy = new Map(within("reported", reported.results).map((r) => [r.job_id, r]));
  const reportedOf = (id: string): UsageTotals | undefined => {
    const r = reportedBy.get(id);
    return r
      ? {
          cost_usd: r.cost_usd,
          active_seconds: r.active_seconds,
          tokens_input: r.tokens_input,
          tokens_output: r.tokens_output,
          tokens_cache_read: r.tokens_cache_read,
          tokens_cache_creation: r.tokens_cache_creation,
        }
      : undefined;
  };

  const totals = {
    telemetry: { ...NO_USAGE, jobs: 0 },
    reported: { ...NO_USAGE, jobs: 0 },
    jobs_without_usage: 0,
  };
  const tally = (source: UsageSource, usage: UsageTotals) => {
    if (source === "none") {
      totals.jobs_without_usage += 1;
      return;
    }
    totals[source] = { ...addUsage(totals[source], usage), jobs: totals[source].jobs + 1 };
  };

  const finished: DigestJob[] = within("finished", outcomes.results).map((r) => {
    const telemetry: UsageTotals = {
      cost_usd: r.cost_usd,
      active_seconds: r.active_seconds,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache_read: r.tokens_cache_read,
      tokens_cache_creation: r.tokens_cache_creation,
    };
    const { usage, source } = chooseUsage(telemetry, reportedOf(r.job_id));
    tally(source, usage);
    return {
      id: r.job_id,
      namespace: r.namespace,
      title: r.title ?? "(job row not found)",
      status: r.status ?? "unknown",
      result_kind: r.result_kind,
      duration_minutes: r.duration_minutes,
      blocked_count: r.blocked_count,
      usage,
      usage_source: source,
    };
  });

  const blockedJobs: DigestBlocked[] = within("blocked", blocked.results).map((r) => {
    const { usage, source } = chooseUsage(NO_USAGE, reportedOf(r.id));
    tally(source, usage);
    return {
      id: r.id,
      namespace: r.namespace,
      title: r.title,
      at: r.updated_at,
      summary: (r.result_summary ?? "").slice(0, SUMMARY_CHARS),
      pull_requests: pullRequestsIn(r.result_summary),
      usage,
      usage_source: source,
    };
  });

  const prRows = within("pull_requests", prs.results);
  const ready: DigestPr[] = prRows
    .filter((p) => p.merged !== 1)
    .map((p) => ({
      job_id: p.job_id,
      namespace: p.namespace,
      url: p.pr_url,
      state: p.merged === 0 ? ("open" as const) : ("unchecked" as const),
      source: "outcome" as const,
    }));
  const seen = new Set(ready.map((p) => p.url));
  for (const b of blockedJobs) {
    for (const url of b.pull_requests) {
      if (seen.has(url)) continue;
      seen.add(url);
      ready.push({
        job_id: b.id,
        namespace: b.namespace,
        url,
        state: "unchecked",
        source: "blocked summary",
      });
    }
  }

  return {
    generated: now.toISOString(),
    since: args.since,
    for_namespace: ns,
    finished,
    blocked: blockedJobs,
    pull_requests_ready: ready,
    pull_requests_merged: prRows.filter((p) => p.merged === 1).length,
    totals,
    truncated,
  };
}
