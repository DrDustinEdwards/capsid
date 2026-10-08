import type { Env } from "./env";
import { PR_URL_SOURCE, ghFetch, parsePrUrl, resolveRepo } from "./github/client";
import { prFacts, verifyEvidence } from "./job-outcomes";
import { auditStatement } from "./store-guards";
import { logEvent } from "./log";

// Merge-state re-verification. An outcome row records merge state when `complete`
// runs, but the seat merges afterwards, so the row would always read "opened, not
// merged". This path updates that one field from GitHub; everything else on an
// outcome row stays write-once.
//
// A URL names a number, not a pull request. A repository that is recreated or
// transferred hands its numbers out again, so each row pins the pull request it named
// (GitHub's node id) on its first read, and every later read refuses a pull request
// whose id differs (migrations/0026, job_6092edef11e1).

// How many rows one sweep re-checks. Bounded because each row costs a GitHub read,
// and walking the whole table would spend the request budget on rows whose answer
// has not changed.
const REVERIFY_PER_SWEEP = 50;

// How far back the sweep looks. A pull request unmerged for a month is not about to
// merge silently, and re-reading it forever would make a bounded job unbounded.
const REVERIFY_WINDOW_DAYS = 30;

/** Which pull request answered at a URL when it was read. */
export interface PrIdentity {
  node_id: string | null;
  created_at: string | null;
}

/** One row per pull request the evidence named, written in the same batch as the outcome.
 *  A pull request complete could read carries its merge state, the time it was read and
 *  its identity; one it could not read stays NULL, for the sweep to retry and pin. */
export function outcomePrStatements(
  db: D1Database,
  jobId: string,
  urls: readonly string[],
  states: Record<string, boolean> = {},
  now?: Date,
  identities: Record<string, PrIdentity> = {}
): D1PreparedStatement[] {
  // Deduplicated here: a PRIMARY KEY conflict would abort the outcome's whole batch.
  const seen = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const at = now && Object.hasOwn(states, trimmed) ? now.toISOString() : null;
    const identity = Object.hasOwn(identities, trimmed) ? identities[trimmed] : undefined;
    statements.push(
      db
        .prepare(
          `INSERT INTO job_outcome_prs (job_id, pr_url, merged, merge_verified_at, pr_node_id, pr_created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (job_id, pr_url) DO NOTHING`
        )
        .bind(jobId, trimmed, at ? (states[trimmed] ? 1 : 0) : null, at, identity?.node_id ?? null, identity?.created_at ?? null)
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

// The outcome's pull request counts, recomputed from its join rows. A row marked
// unverifiable is in no count: prs_merged leaves it out, and prs_opened stays the
// driver's number, unverified, for as long as any row is unread or unverifiable, so no
// reader takes the merged count for a total (the rule verifyEvidence already applies
// to a partly read list). recordFor (src/agent-record.ts) counts merges only when
// prs_opened is verified. A true flag is never downgraded.
function recountStatement(db: D1Database, jobId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE job_outcomes
         SET prs_merged = (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND merged = 1 AND unverifiable IS NULL),
             prs_opened = CASE
               WHEN (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND (merge_verified_at IS NULL OR unverifiable IS NOT NULL)) = 0
                 THEN (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1)
               ELSE prs_opened
             END,
             verified = CASE
               WHEN (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND (merge_verified_at IS NULL OR unverifiable IS NOT NULL)) = 0
                 THEN json_set(json_set(verified, '$.prs_merged', json('true')), '$.prs_opened', json('true'))
               ELSE json_set(verified, '$.prs_merged', json('true'))
             END
       WHERE job_id = ?1`
    )
    .bind(jobId);
}

/** The two statements that record one pull request's merge state against one outcome,
 *  pinning its identity when the row has none yet. A row already marked unverifiable is
 *  never written. Exported as a builder so the integration suite can run the real SQL
 *  against D1; reverifyPr itself needs GitHub, which the integration runtime cannot reach. */
export function reverifyStatements(
  db: D1Database,
  jobId: string,
  prUrl: string,
  merged: boolean,
  now: Date,
  pin?: PrIdentity
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE job_outcome_prs
           SET merged = ?3, merge_verified_at = ?4,
               pr_node_id = COALESCE(pr_node_id, ?5), pr_created_at = COALESCE(pr_created_at, ?6)
         WHERE job_id = ?1 AND pr_url = ?2 AND unverifiable IS NULL`
      )
      .bind(jobId, prUrl, merged ? 1 : 0, now.toISOString(), pin?.node_id ?? null, pin?.created_at ?? null),
    recountStatement(db, jobId),
  ];
}

export type Unverifiable = "identity-changed" | "repo-recreated";

/** Mark one row unverifiable, once, with its reason, and recount the outcome without it.
 *  The row keeps what it held; it is only never read by URL again. */
export function unverifiableStatements(
  db: D1Database,
  jobId: string,
  prUrl: string,
  kind: Unverifiable,
  note: string,
  now: Date
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE job_outcome_prs SET unverifiable = ?3, unverifiable_note = ?4, unverifiable_at = ?5
         WHERE job_id = ?1 AND pr_url = ?2 AND unverifiable IS NULL`
      )
      .bind(jobId, prUrl, kind, note, now.toISOString()),
    recountStatement(db, jobId),
  ];
}

// A time from GitHub (ISO with a zone) or from D1 (datetime('now'), "YYYY-MM-DD HH:MM:SS",
// which is UTC) as milliseconds, or NaN.
function instant(t: string | null | undefined): number {
  if (!t) return Number.NaN;
  const iso = /^\d{4}-\d\d-\d\d \d/.test(t) ? `${t.replace(" ", "T")}${/(Z|[+-]\d\d:?\d\d)$/.test(t) ? "" : "Z"}` : t;
  return Date.parse(iso);
}

/** When the repository a pull request URL names was created, or null when it could not
 *  be read. Resolved through the namespace mapping, as prFacts is. */
async function repoCreatedAt(env: Env, namespace: string, prUrl: string): Promise<string | null> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return null;
  try {
    const resolved = await resolveRepo(env, namespace, `${parsed.owner}/${parsed.repo}`);
    const resp = await ghFetch(env, resolved.owner, resolved.repo, `/repos/${resolved.owner}/${resolved.repo}`);
    if (!resp.ok) return null;
    const body = (await resp.json()) as { created_at?: unknown };
    return typeof body.created_at === "string" ? body.created_at : null;
  } catch (err) {
    // A read that could not run leaves the unpinned row as it was, never pinned to a
    // pull request nobody checked; the reason is logged, not swallowed.
    logEvent("warn", "OUTCOME_PRS_REPO_UNREADABLE", { message: `outcome-prs: could not read the repository behind ${prUrl}: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
}

type Decision = { kind: "verify"; pin?: PrIdentity } | { kind: "mark"; why: Unverifiable; note: string } | { kind: "leave" };

/**
 * Whether the pull request GitHub answered with is the one a row named. answered is
 * null when the pull request could not be read (a recreated repository may not have
 * reached the number yet).
 *
 * A pinned row compares node ids. An unpinned row (recorded before the id was kept, or
 * complete could not read it) is pinned now, unless the repository was created after
 * the outcome named the pull request (it was recreated, decided without the pull
 * request) or the pull request answering was opened after it; neither can be the one
 * named. Anything that cannot be compared leaves the row as it was, to be tried again:
 * a guess would be the failure this exists to prevent.
 */
function decide(
  row: { pr_node_id: string | null; named_at: string | null },
  answered: PrIdentity | null,
  repoCreated: string | null,
  prUrl: string
): Decision {
  if (row.pr_node_id) {
    if (!answered?.node_id) return { kind: "leave" };
    if (row.pr_node_id === answered.node_id) return { kind: "verify" };
    return {
      kind: "mark",
      why: "identity-changed",
      note: `${prUrl} now answers as ${answered.node_id} (opened ${answered.created_at ?? "at an unknown time"}), not ${row.pr_node_id}, the pull request this row named`,
    };
  }
  const named = instant(row.named_at);
  const born = instant(repoCreated);
  if (Number.isNaN(named) || Number.isNaN(born)) return { kind: "leave" };
  if (born > named) {
    return {
      kind: "mark",
      why: "repo-recreated",
      note: `the repository behind ${prUrl} was created ${repoCreated}, after the outcome named this pull request (${row.named_at}), so the number no longer names it`,
    };
  }
  if (!answered?.node_id) return { kind: "leave" };
  const opened = instant(answered.created_at);
  if (Number.isNaN(opened)) return { kind: "leave" };
  if (opened > named) {
    return {
      kind: "mark",
      why: "identity-changed",
      note: `${prUrl} now answers as ${answered.node_id}, opened ${answered.created_at}, after the outcome named this pull request (${row.named_at})`,
    };
  }
  return { kind: "verify", pin: answered };
}

/**
 * Re-read one pull request and write what GitHub says, for every outcome row that
 * named it and that it is still the pull request of. prs_merged is a COUNT over the
 * join rows, not an increment, because this runs on a merge and on a sweep and so will
 * run twice on the same pull request. A row whose number now belongs to a different
 * pull request is marked unverifiable instead, and is not in the result.
 */
export async function reverifyPr(
  env: Env,
  namespace: string,
  prUrl: string,
  now: Date
): Promise<ReverifyOutcome[]> {
  // named_at is when the outcome was recorded, which is when the driver named the pull
  // request; a row the sweep seeded later carries its own, later, recorded_at.
  const rows = await env.DB.prepare(
    `SELECT p.job_id, p.merged, p.pr_node_id, COALESCE(o.recorded_at, p.recorded_at) AS named_at
     FROM job_outcome_prs p LEFT JOIN job_outcomes o ON o.job_id = p.job_id
     WHERE p.pr_url = ?1 AND p.unverifiable IS NULL`
  )
    .bind(prUrl)
    .all<{ job_id: string; merged: number | null; pr_node_id: string | null; named_at: string | null }>();
  const named = rows.results ?? [];
  if (named.length === 0) return [];

  // A failed read of the pull request writes no merge state; only a row whose
  // repository was recreated can still be decided, since that needs no pull request.
  const facts = await prFacts(env, namespace, prUrl);
  const answered: PrIdentity | null = typeof facts === "string" ? null : { node_id: facts.node_id, created_at: facts.created_at };

  // Read once, and only when some row has nothing pinned to compare against.
  const repoCreated = named.some((r) => !r.pr_node_id) ? await repoCreatedAt(env, namespace, prUrl) : null;

  const merged = typeof facts !== "string" && facts.merged === true;
  const out: ReverifyOutcome[] = [];
  for (const row of named) {
    const decision = decide(row, answered, repoCreated, prUrl);
    if (decision.kind === "leave") continue;
    if (decision.kind === "mark") {
      await env.DB.batch(unverifiableStatements(env.DB, row.job_id, prUrl, decision.why, decision.note, now));
      continue;
    }
    const before = row.merged;
    await env.DB.batch(reverifyStatements(env.DB, row.job_id, prUrl, merged, now, decision.pin));
    out.push({ job_id: row.job_id, pr_url: prUrl, merged, changed: before === null || before !== (merged ? 1 : 0) });
  }
  return out;
}

/**
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
       AND p.unverifiable IS NULL
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
  // Outcomes whose commits, files and CI were read from GitHub for the first time.
  backfilled: number;
}

const BACKFILL_ACTOR = "system:outcome-backfill";

/**
 * Outcomes recorded wrong by the bug job_d5262df1dc32 fixed: a pull request named only
 * in result_ref was never read, so commits, files_changed and ci_green sit unverified
 * (and prs_opened and prs_merged did too, until the seed below counted them). For each
 * such row in the window this reads every pull request the job names (its join rows and
 * its result_ref) the way complete does now, and writes GitHub's numbers. A row is
 * touched only while its commits are still unverified, and only when every named pull
 * request was read; one that was not stays as it was for the next sweep. tests_added is
 * the driver's and is never touched. Each correction is an audit_log row holding the
 * values before and after, so nothing here is an edit by hand.
 *
 * Bounded by `limit` per sweep and by the window, like the rest of the sweep. A row whose
 * pull request GitHub will not answer for is re-read each sweep until it leaves the window.
 */
async function backfillOutcomes(env: Env, now: Date, limit = REVERIFY_PER_SWEEP): Promise<{ backfilled: number; unread: number }> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * 86_400_000).toISOString();
  const candidates = await env.DB.prepare(
    `SELECT o.job_id, o.namespace, j.result_ref, o.prs_opened, o.prs_merged, o.commits, o.files_changed, o.ci_green, o.verified
     FROM job_outcomes o JOIN jobs j ON j.id = o.job_id
     WHERE o.result_kind = 'pr'
       AND o.recorded_at >= ?1
       AND j.status <> 'superseded'
       AND j.result_ref LIKE 'https://github.com/%/pull/%'
       AND CASE WHEN json_valid(o.verified) THEN json_extract(o.verified, '$.commits') END = 0
     ORDER BY o.recorded_at DESC
     LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ job_id: string; namespace: string; result_ref: string; prs_opened: number | null; prs_merged: number | null; commits: number | null; files_changed: number | null; ci_green: number | null; verified: string }>();

  let backfilled = 0;
  let unread = 0;
  for (const row of candidates.results ?? []) {
    const joined = await env.DB.prepare("SELECT pr_url FROM job_outcome_prs WHERE job_id = ?1").bind(row.job_id).all<{ pr_url: string }>();
    const named = (joined.results ?? []).map((r) => r.pr_url);
    const verdict = await verifyEvidence(env, row.namespace, named.length > 0 ? { prs: named } : undefined, row.result_ref);
    if (!verdict.verified.commits) {
      unread += 1;
      continue;
    }
    const urls = [...new Set([...named, row.result_ref.trim()])];
    await env.DB.batch([
      ...outcomePrStatements(env.DB, row.job_id, urls, verdict.pr_states, now, verdict.pr_identity),
      env.DB.prepare(
        `UPDATE job_outcomes SET prs_opened = ?2, prs_merged = ?3, commits = ?4, files_changed = ?5, ci_green = ?6, verified = ?7
         WHERE job_id = ?1 AND CASE WHEN json_valid(verified) THEN json_extract(verified, '$.commits') END = 0`
      ).bind(row.job_id, verdict.prs_opened, verdict.prs_merged, verdict.commits, verdict.files_changed, verdict.ci_green, JSON.stringify(verdict.verified)),
      auditStatement(env.DB, BACKFILL_ACTOR, "outcome-backfilled", row.namespace, `jobs/${row.job_id}.md`, {
        job_id: row.job_id,
        urls,
        before: { prs_opened: row.prs_opened, prs_merged: row.prs_merged, commits: row.commits, files_changed: row.files_changed, ci_green: row.ci_green, verified: row.verified },
        after: { prs_opened: verdict.prs_opened, prs_merged: verdict.prs_merged, commits: verdict.commits, files_changed: verdict.files_changed, ci_green: verdict.ci_green, verified: verdict.verified },
      }),
    ]);
    backfilled += 1;
  }
  return { backfilled, unread };
}

/**
 * One sweep. Seeds join rows for outcomes that stored none, then re-verifies what is
 * due. Older rows name their pull requests only in result_ref and the summary, so the
 * seed reads those. Every seeded URL is verified against GitHub before it is counted.
 */
export async function reverifySweep(env: Env, now: Date, limit = REVERIFY_PER_SWEEP): Promise<SweepReport> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * 86_400_000).toISOString();
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
  return { checked, changed, seeded, backfilled };
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
