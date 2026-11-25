import type { Env } from "./env";
import { verifyEvidence } from "./job-outcomes";
import { auditStatement } from "./store-guards";
import { DAY_MS } from "./time";
import { outcomePrStatements, prUrlsFromJob, reverifyPr } from "./outcome-prs";

// The daily sweep that seeds, backfills and re-verifies outcome pull requests.

// How many rows one sweep re-checks. Bounded because each row costs a GitHub read,
// and walking the whole table would spend the request budget on rows whose answer
// has not changed.
const REVERIFY_PER_SWEEP = 50;

// How far back the sweep looks. A pull request unmerged for a month is not about to
// merge silently, and re-reading it forever would make a bounded job unbounded.
const REVERIFY_WINDOW_DAYS = 30;

// The pull requests whose merge status is due a re-read: those belonging to outcomes recorded
// inside the window and not already known merged. /
export async function dueForReverify(
  env: Env,
  now: Date,
  limit = REVERIFY_PER_SWEEP,
): Promise<Array<{ job_id: string; pr_url: string; namespace: string }>> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * DAY_MS).toISOString();
  // A superseded job is skipped here and in the seed: no work was done on it.
  const rows = await env.DB.prepare(
    `SELECT p.job_id, p.pr_url, o.namespace
     FROM job_outcome_prs p
     JOIN job_outcomes o ON o.job_id = p.job_id
     WHERE (p.merged IS NULL OR p.merged = 0)
       AND p.unverifiable IS NULL
       AND o.recorded_at >= ?1
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p.job_id AND j.status = 'superseded')
     ORDER BY p.merge_verified_at IS NOT NULL, p.merge_verified_at ASC
     LIMIT ?2`,
  )
    .bind(cutoff, limit)
    .all<{ job_id: string; pr_url: string; namespace: string }>();
  return rows.results ?? [];
}

export interface SweepReport {
  checked: number;
  changed: number;
  seeded: number;
  // Outcomes whose commits, files and CI were read from GitHub for the first time.
  backfilled: number;
}

const BACKFILL_ACTOR = "system:outcome-backfill";

// Outcomes whose pull request, named only in result_ref, was never read, so commits, files_changed
// and ci_green sit unverified. For each such row in the window this reads every pull request the
// job names (its join rows and its result_ref) the way complete does now, and writes GitHub's
// numbers.
async function backfillOutcomes(
  env: Env,
  now: Date,
  limit = REVERIFY_PER_SWEEP,
): Promise<{ backfilled: number; unread: number }> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * DAY_MS).toISOString();
  const candidates = await env.DB.prepare(
    `SELECT o.job_id, o.namespace, j.result_ref, o.prs_opened, o.prs_merged, o.commits, o.files_changed, o.ci_green, o.verified
     FROM job_outcomes o JOIN jobs j ON j.id = o.job_id
     WHERE o.result_kind = 'pr'
       AND o.recorded_at >= ?1
       AND j.status <> 'superseded'
       AND j.result_ref LIKE 'https://github.com/%/pull/%'
       AND CASE WHEN json_valid(o.verified) THEN json_extract(o.verified, '$.commits') END = 0
     ORDER BY o.recorded_at DESC
     LIMIT ?2`,
  )
    .bind(cutoff, limit)
    .all<{
      job_id: string;
      namespace: string;
      result_ref: string;
      prs_opened: number | null;
      prs_merged: number | null;
      commits: number | null;
      files_changed: number | null;
      ci_green: number | null;
      verified: string;
    }>();

  let backfilled = 0;
  let unread = 0;
  for (const row of candidates.results ?? []) {
    const joined = await env.DB.prepare("SELECT pr_url FROM job_outcome_prs WHERE job_id = ?1")
      .bind(row.job_id)
      .all<{ pr_url: string }>();
    const named = (joined.results ?? []).map((r) => r.pr_url);
    const verdict = await verifyEvidence(
      env,
      row.namespace,
      named.length > 0 ? { prs: named } : undefined,
      row.result_ref,
    );
    if (!verdict.verified.commits) {
      unread += 1;
      continue;
    }
    const urls = [...new Set([...named, row.result_ref.trim()])];
    await env.DB.batch([
      ...outcomePrStatements(env.DB, row.job_id, urls, verdict.pr_states, now, verdict.pr_identity),
      env.DB.prepare(
        `UPDATE job_outcomes SET prs_opened = ?2, prs_merged = ?3, commits = ?4, files_changed = ?5, ci_green = ?6, verified = ?7
         WHERE job_id = ?1 AND CASE WHEN json_valid(verified) THEN json_extract(verified, '$.commits') END = 0`,
      ).bind(
        row.job_id,
        verdict.prs_opened,
        verdict.prs_merged,
        verdict.commits,
        verdict.files_changed,
        verdict.ci_green,
        JSON.stringify(verdict.verified),
      ),
      auditStatement(
        env.DB,
        BACKFILL_ACTOR,
        "outcome-backfilled",
        row.namespace,
        `jobs/${row.job_id}.md`,
        {
          job_id: row.job_id,
          urls,
          before: {
            prs_opened: row.prs_opened,
            prs_merged: row.prs_merged,
            commits: row.commits,
            files_changed: row.files_changed,
            ci_green: row.ci_green,
            verified: row.verified,
          },
          after: {
            prs_opened: verdict.prs_opened,
            prs_merged: verdict.prs_merged,
            commits: verdict.commits,
            files_changed: verdict.files_changed,
            ci_green: verdict.ci_green,
            verified: verdict.verified,
          },
        },
      ),
    ]);
    backfilled += 1;
  }
  return { backfilled, unread };
}

// One sweep. Seeds join rows for outcomes that stored none, then re-verifies what is due. Older
// rows name their pull requests only in result_ref and the summary, so the seed reads those. Every
// seeded URL is verified against GitHub before it is counted. /
export async function reverifySweep(
  env: Env,
  now: Date,
  limit = REVERIFY_PER_SWEEP,
): Promise<SweepReport> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * DAY_MS).toISOString();
  // First, so a row it corrects gets its join rows with merge state before the seed below
  // would give it empty ones.
  const { backfilled } = await backfillOutcomes(env, now, limit);
  const unseeded = await env.DB.prepare(
    `SELECT o.job_id, o.namespace, j.result_ref, j.result_summary
     FROM job_outcomes o
     JOIN jobs j ON j.id = o.job_id
     WHERE o.result_kind = 'pr'
       AND o.recorded_at >= ?1
       AND j.status <> 'superseded'
       AND NOT EXISTS (SELECT 1 FROM job_outcome_prs p WHERE p.job_id = o.job_id)
     LIMIT ?2`,
  )
    .bind(cutoff, limit)
    .all<{
      job_id: string;
      namespace: string;
      result_ref: string | null;
      result_summary: string | null;
    }>();

  let seeded = 0;
  for (const row of unseeded.results ?? []) {
    const urls = prUrlsFromJob(row);
    if (urls.length === 0) continue;
    const statements = outcomePrStatements(env.DB, row.job_id, urls);
    if (statements.length === 0) continue;
    await env.DB.batch(statements);
    seeded += statements.length;
  }

  let checked = 0;
  let changed = 0;
  for (const due of await dueForReverify(env, now, limit)) {
    const results = await reverifyPr(env, due.namespace, due.pr_url, now);
    checked += 1;
    changed += results.filter((r) => r.changed).length;
  }
  return { checked, changed, seeded, backfilled };
}

const SWEEP_STAMP_KEY = "outcomes:reverify:last";
const SWEEP_INTERVAL_MS = DAY_MS;

// Run a sweep at most once a day, on the five-minute tick. The merge path already handles merges
// the Worker makes. Returns null when it was not due. /
export async function sweepIfDue(env: Env, now: Date): Promise<SweepReport | null> {
  let last: string | null = null;
  try {
    last = await env.APP_KV.get(SWEEP_STAMP_KEY);
  } catch {
    // An unreadable stamp runs the sweep, which is bounded and idempotent.
    last = null;
  }
  if (last) {
    const parsed = Date.parse(last);
    if (!Number.isNaN(parsed) && now.getTime() - parsed < SWEEP_INTERVAL_MS) return null;
  }
  const report = await reverifySweep(env, now);
  await env.APP_KV.put(SWEEP_STAMP_KEY, now.toISOString());
  return report;
}
