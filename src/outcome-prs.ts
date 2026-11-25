import type { Env } from "./env";
import { PR_URL_SOURCE, parsePrUrl } from "@dustinedwards/site-runtime/github";
import { ghFetch, resolveRepo } from "./github/client";
import { prFacts } from "./job-outcomes";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { timeMs } from "./time";

// Merge-state re-verification. An outcome row records merge state when `complete` runs, but the
// seat merges afterwards, so the row would always read "opened, not merged". This path updates that
// one field from GitHub; everything else on an outcome row stays write-once.

/** Which pull request answered at a URL when it was read. */
export interface PrIdentity {
  node_id: string | null;
  created_at: string | null;
}

// One row per pull request the evidence named, written in the same batch as the outcome. A pull
// request complete could read carries its merge state, the time it was read and its identity; one
// it could not read stays NULL, for the sweep to retry and pin.
export function outcomePrStatements(
  db: D1Database,
  jobId: string,
  urls: readonly string[],
  states: Record<string, boolean> = {},
  now?: Date,
  identities: Record<string, PrIdentity> = {},
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
           VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (job_id, pr_url) DO NOTHING`,
        )
        .bind(
          jobId,
          trimmed,
          at ? (states[trimmed] ? 1 : 0) : null,
          at,
          identity?.node_id ?? null,
          identity?.created_at ?? null,
        ),
    );
  }
  return statements;
}

/** Extract the pull request URLs a finished job referred to, for a row that stored none. */
export function prUrlsFromJob(job: {
  result_ref: string | null;
  result_summary: string | null;
}): string[] {
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

// The outcome's pull request counts, recomputed from its join rows.
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
       WHERE job_id = ?1`,
    )
    .bind(jobId);
}

// The two statements that record one pull request's merge state against one outcome, pinning its
// identity when the row has none yet. A row already marked unverifiable is never written.
export function reverifyStatements(
  db: D1Database,
  jobId: string,
  prUrl: string,
  merged: boolean,
  now: Date,
  pin?: PrIdentity,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE job_outcome_prs
           SET merged = ?3, merge_verified_at = ?4,
               pr_node_id = COALESCE(pr_node_id, ?5), pr_created_at = COALESCE(pr_created_at, ?6)
         WHERE job_id = ?1 AND pr_url = ?2 AND unverifiable IS NULL`,
      )
      .bind(
        jobId,
        prUrl,
        merged ? 1 : 0,
        now.toISOString(),
        pin?.node_id ?? null,
        pin?.created_at ?? null,
      ),
    recountStatement(db, jobId),
  ];
}

export type Unverifiable = "identity-changed" | "repo-recreated";

// Mark one row unverifiable, once, with its reason, and recount the outcome without it. The row
// keeps what it held; it is only never read by URL again.
export function unverifiableStatements(
  db: D1Database,
  jobId: string,
  prUrl: string,
  kind: Unverifiable,
  note: string,
  now: Date,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE job_outcome_prs SET unverifiable = ?3, unverifiable_note = ?4, unverifiable_at = ?5
         WHERE job_id = ?1 AND pr_url = ?2 AND unverifiable IS NULL`,
      )
      .bind(jobId, prUrl, kind, note, now.toISOString()),
    recountStatement(db, jobId),
  ];
}

// When the repository a pull request URL names was created, or null when it could not be read.
// Resolved through the namespace mapping, as prFacts is.
async function repoCreatedAt(env: Env, namespace: string, prUrl: string): Promise<string | null> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return null;
  try {
    const resolved = await resolveRepo(env, namespace, `${parsed.owner}/${parsed.repo}`);
    const resp = await ghFetch(
      env,
      resolved.owner,
      resolved.repo,
      `/repos/${resolved.owner}/${resolved.repo}`,
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as { created_at?: unknown };
    return typeof body.created_at === "string" ? body.created_at : null;
  } catch (err) {
    // A read that could not run leaves the unpinned row as it was, never pinned to a
    // pull request nobody checked; the reason is logged, not swallowed.
    logEvent(
      "OUTCOME_PRS_REPO_UNREADABLE",
      {
        message: `outcome-prs: could not read the repository behind ${prUrl}: ${errorMessage(err)}`,
      },
      { level: "warn" },
    );
    return null;
  }
}

type Decision =
  | { kind: "verify"; pin?: PrIdentity }
  | { kind: "mark"; why: Unverifiable; note: string }
  | { kind: "leave" };

// Whether the pull request GitHub answered with is the one a row named. answered is null when the
// pull request could not be read (a recreated repository may not have reached the number yet). A
// pinned row compares node ids.
function decide(
  row: { pr_node_id: string | null; named_at: string | null },
  answered: PrIdentity | null,
  repoCreated: string | null,
  prUrl: string,
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
  const named = timeMs(row.named_at);
  const born = timeMs(repoCreated);
  if (Number.isNaN(named) || Number.isNaN(born)) return { kind: "leave" };
  if (born > named) {
    return {
      kind: "mark",
      why: "repo-recreated",
      note: `the repository behind ${prUrl} was created ${repoCreated}, after the outcome named this pull request (${row.named_at}), so the number no longer names it`,
    };
  }
  if (!answered?.node_id) return { kind: "leave" };
  const opened = timeMs(answered.created_at);
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

// Re-read one pull request and write what GitHub says, for every outcome row that named it and that
// it is still the pull request of. prs_merged is a COUNT over the join rows, not an increment,
// because this runs on a merge and on a sweep and so will run twice on the same pull request.
export async function reverifyPr(
  env: Env,
  namespace: string,
  prUrl: string,
  now: Date,
): Promise<ReverifyOutcome[]> {
  // named_at is when the outcome was recorded, which is when the driver named the pull
  // request; a row the sweep seeded later carries its own, later, recorded_at.
  const rows = await env.DB.prepare(
    `SELECT p.job_id, p.merged, p.pr_node_id, COALESCE(o.recorded_at, p.recorded_at) AS named_at
     FROM job_outcome_prs p LEFT JOIN job_outcomes o ON o.job_id = p.job_id
     WHERE p.pr_url = ?1 AND p.unverifiable IS NULL`,
  )
    .bind(prUrl)
    .all<{
      job_id: string;
      merged: number | null;
      pr_node_id: string | null;
      named_at: string | null;
    }>();
  const named = rows.results ?? [];
  if (named.length === 0) return [];

  // A failed read of the pull request writes no merge state; only a row whose
  // repository was recreated can still be decided, since that needs no pull request.
  const facts = await prFacts(env, namespace, prUrl);
  const answered: PrIdentity | null =
    typeof facts === "string" ? null : { node_id: facts.node_id, created_at: facts.created_at };

  // Read once, and only when some row has nothing pinned to compare against.
  const repoCreated = named.some((r) => !r.pr_node_id)
    ? await repoCreatedAt(env, namespace, prUrl)
    : null;

  const merged = typeof facts !== "string" && facts.merged === true;
  const out: ReverifyOutcome[] = [];
  for (const row of named) {
    const decision = decide(row, answered, repoCreated, prUrl);
    if (decision.kind === "leave") continue;
    if (decision.kind === "mark") {
      await env.DB.batch(
        unverifiableStatements(env.DB, row.job_id, prUrl, decision.why, decision.note, now),
      );
      continue;
    }
    const before = row.merged;
    await env.DB.batch(reverifyStatements(env.DB, row.job_id, prUrl, merged, now, decision.pin));
    out.push({
      job_id: row.job_id,
      pr_url: prUrl,
      merged,
      changed: before === null || before !== (merged ? 1 : 0),
    });
  }
  return out;
}
