import type { Env } from "./env";
import { PR_URL_SOURCE } from "./github/client";
import { prFacts } from "./job-outcomes";

// Merge-state re-verification. An outcome row records merge state when `complete`
// runs, but the seat merges afterwards, so the row would always read "opened, not
// merged". This path updates that one field from GitHub; everything else on an
// outcome row stays write-once.

// How many rows one sweep re-checks. Bounded because each row costs a GitHub read,
// and walking the whole table would spend the request budget on rows whose answer
// has not changed.
const REVERIFY_PER_SWEEP = 50;

// How far back the sweep looks. A pull request unmerged for a month is not about to
// merge silently, and re-reading it forever would make a bounded job unbounded.
const REVERIFY_WINDOW_DAYS = 30;

/** One row per pull request the evidence named, written in the same batch as the outcome.
 *  A pull request complete could read carries its merge state and the time it was read;
 *  one it could not read stays NULL, for the sweep to retry. */
export function outcomePrStatements(
  db: D1Database,
  jobId: string,
  urls: readonly string[],
  states: Record<string, boolean> = {},
  now?: Date
): D1PreparedStatement[] {
  // Deduplicated here: a PRIMARY KEY conflict would abort the outcome's whole batch.
  const seen = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const at = now && Object.hasOwn(states, trimmed) ? now.toISOString() : null;
    statements.push(
      db
        .prepare(
          `INSERT INTO job_outcome_prs (job_id, pr_url, merged, merge_verified_at)
           VALUES (?1, ?2, ?3, ?4) ON CONFLICT (job_id, pr_url) DO NOTHING`
        )
        .bind(jobId, trimmed, at ? (states[trimmed] ? 1 : 0) : null, at)
    );
  }
  return statements;
}

/** Extract the pull request URLs a finished job referred to, for a row that stored none. */
export function prUrlsFromJob(job: { result_ref: string | null; result_summary: string | null }): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(PR_URL_SOURCE, "g");
  for (const text of [job.result_ref ?? "", job.result_summary ?? ""]) {
    for (const match of text.match(pattern) ?? []) found.add(match);
  }
  return [...found];
}

export interface ReverifyOutcome {
  job_id: string;
  pr_url: string;
  merged: boolean;
  changed: boolean;
}

/** The two statements that record one pull request's merge state against one outcome.
 *  Exported as a builder so the integration suite can run the real SQL against D1;
 *  reverifyPr itself needs GitHub, which the integration runtime cannot reach. */
export function reverifyStatements(db: D1Database, jobId: string, prUrl: string, merged: boolean, now: Date): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE job_outcome_prs SET merged = ?3, merge_verified_at = ?4 WHERE job_id = ?1 AND pr_url = ?2")
      .bind(jobId, prUrl, merged ? 1 : 0, now.toISOString()),
    // prs_merged is recomputed from the join rows and marked verified. prs_opened and
    // its flag follow once no join row is still unread, because recordFor
    // (src/agent-record.ts) counts merges only when prs_opened is verified. A true
    // flag is never downgraded.
    db
      .prepare(
        `UPDATE job_outcomes
           SET prs_merged = (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND merged = 1),
               prs_opened = CASE
                 WHEN (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND merge_verified_at IS NULL) = 0
                   THEN (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1)
                 ELSE prs_opened
               END,
               verified = CASE
                 WHEN (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND merge_verified_at IS NULL) = 0
                   THEN json_set(json_set(verified, '$.prs_merged', json('true')), '$.prs_opened', json('true'))
                 ELSE json_set(verified, '$.prs_merged', json('true'))
               END
         WHERE job_id = ?1`
      )
      .bind(jobId),
  ];
}

/**
 * Re-read one pull request and write what GitHub says, for every outcome row that
 * named it. prs_merged is a COUNT over the join rows, not an increment, because this
 * runs on a merge and on a sweep and so will run twice on the same pull request.
 */
export async function reverifyPr(
  env: Env,
  namespace: string,
  prUrl: string,
  now: Date
): Promise<ReverifyOutcome[]> {
  const rows = await env.DB.prepare("SELECT job_id, merged FROM job_outcome_prs WHERE pr_url = ?1")
    .bind(prUrl)
    .all<{ job_id: string; merged: number | null }>();
  const named = rows.results ?? [];
  if (named.length === 0) return [];

  const facts = await prFacts(env, namespace, prUrl);
  // A failed read leaves every row as it was.
  if (typeof facts === "string") return [];

  const merged = facts.merged === true;
  const out: ReverifyOutcome[] = [];
  for (const row of named) {
    const before = row.merged;
    await env.DB.batch(reverifyStatements(env.DB, row.job_id, prUrl, merged, now));
    out.push({ job_id: row.job_id, pr_url: prUrl, merged, changed: before === null || before !== (merged ? 1 : 0) });
  }
  return out;
}

/**
 * The rows a sweep should look at: pull requests never checked, or checked longest
 * ago, belonging to outcomes recorded inside the window and not already known merged.
 */
export async function dueForReverify(
  env: Env,
  now: Date,
  limit = REVERIFY_PER_SWEEP
): Promise<Array<{ job_id: string; pr_url: string; namespace: string }>> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * 86_400_000).toISOString();
  // A superseded job is skipped here and in the seed: no work was done on it.
  const rows = await env.DB.prepare(
    `SELECT p.job_id, p.pr_url, o.namespace
     FROM job_outcome_prs p
     JOIN job_outcomes o ON o.job_id = p.job_id
     WHERE (p.merged IS NULL OR p.merged = 0)
       AND o.recorded_at >= ?1
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p.job_id AND j.status = 'superseded')
     ORDER BY p.merge_verified_at IS NOT NULL, p.merge_verified_at ASC
     LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ job_id: string; pr_url: string; namespace: string }>();
  return rows.results ?? [];
}

export interface SweepReport {
  checked: number;
  changed: number;
  seeded: number;
}

/**
 * One sweep. Seeds join rows for outcomes that stored none, then re-verifies what is
 * due. Older rows name their pull requests only in result_ref and the summary, so the
 * seed reads those. Every seeded URL is verified against GitHub before it is counted.
 */
export async function reverifySweep(env: Env, now: Date, limit = REVERIFY_PER_SWEEP): Promise<SweepReport> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * 86_400_000).toISOString();
  const unseeded = await env.DB.prepare(
    `SELECT o.job_id, o.namespace, j.result_ref, j.result_summary
     FROM job_outcomes o
     JOIN jobs j ON j.id = o.job_id
     WHERE o.result_kind = 'pr'
       AND o.recorded_at >= ?1
       AND j.status <> 'superseded'
       AND NOT EXISTS (SELECT 1 FROM job_outcome_prs p WHERE p.job_id = o.job_id)
     LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ job_id: string; namespace: string; result_ref: string | null; result_summary: string | null }>();

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
  return { checked, changed, seeded };
}

const SWEEP_STAMP_KEY = "outcomes:reverify:last";
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Run a sweep at most once a day, on the five-minute tick. The merge path already
 * handles merges the Worker makes. Returns null when it was not due.
 */
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
