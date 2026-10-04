import { z } from "zod";
import type { EvidenceVerdict, JobEvidence } from "./job-outcomes";
import { bounded } from "./limits";

// WHAT THE AGENT SAID, kept apart from what the Worker verified (migrations/0023).
//
// job_outcomes stores GitHub's number in place of the driver's wherever GitHub could
// answer, so the driver's own account was overwritten at the moment it was recorded.
// This module records that account first, in job_claims, from the arguments exactly as
// they arrived, and then one job_evaluations row per check with the claim and the
// verified value side by side. Both are written in the transition's own batch
// (holderTransition, src/jobs-holder.ts), so a claim exists exactly when the
// transition it describes does.
//
// NULL IS NOT FALSE, on 0011's reasoning: a field the agent did not state is NULL,
// never 0 and never false. "Nobody said" and "said none" are different facts.

const CLAIM_TESTS_RESULTS = ["pass", "fail", "partial", "not_run"] as const;
const CLAIM_DEPLOY_STATES = ["none", "pending", "deployed", "verified", "failed"] as const;

// Bounds on what one claim may carry. A claim is stored whole, so each list and each
// string is bounded where it arrives rather than truncated where it is written.
export const MAX_CLAIM_PRS = 10;
const MAX_CLAIM_URL = 512;
const MAX_CLAIM_FILES = 500;
const MAX_CLAIM_PATH = 512;
const MAX_CLAIM_VERSION = 128;

const count = z.number().int().nonnegative();
const version = bounded(MAX_CLAIM_VERSION);
// A usage figure the agent read off its own session. finite() so NaN and Infinity, which
// JSON cannot carry but a caller object can, are refused here and never reach SUM().
const usageAmount = z.number().finite().nonnegative();

// Strict at every level: an unknown key is refused, never dropped. A dropped key is a
// claim the agent made and the record does not have, which is the loss this table
// exists to prevent.
export const claimSchema = z
  .object({
    prs_opened: z.array(bounded(MAX_CLAIM_URL)).max(MAX_CLAIM_PRS).optional().describe("Pull request URLs this job opened."),
    prs_merged: z.array(bounded(MAX_CLAIM_URL)).max(MAX_CLAIM_PRS).optional().describe("Pull request URLs this job says are merged."),
    tests: z
      .object({
        run: count.optional(),
        passed: count.optional(),
        failed: count.optional(),
        result: z.enum(CLAIM_TESTS_RESULTS).optional(),
      })
      .strict()
      .optional()
      .describe("Tests the agent ran, and their result."),
    deploy_state: z.enum(CLAIM_DEPLOY_STATES).optional(),
    files_touched: z.array(bounded(MAX_CLAIM_PATH)).max(MAX_CLAIM_FILES).optional().describe("Repo-relative paths the agent touched."),
    usage: z
      .object({
        cost_usd: usageAmount.optional(),
        active_seconds: usageAmount.optional(),
        tokens: z
          .object({
            input: count.optional(),
            output: count.optional(),
            cache_read: count.optional(),
            cache_creation: count.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional()
      .describe(
        "What this session used, as the session reports it: cost_usd, active_seconds and tokens {input, output, cache_read, cache_creation}. This session's own total, not a running total across earlier claims on the job. Self-reported, recorded and never used to authorize anything. Telemetry (docs/telemetry.md) stays the measured source; the claims aggregate shows both side by side."
      ),
    versions: z
      .object({
        model_id: version.optional(),
        client_name: version.optional(),
        client_version: version.optional(),
        permission_mode: version.optional(),
      })
      .strict()
      .optional()
      .describe("Self-reported, recorded and never used to authorize anything."),
  })
  .strict();

export type JobClaim = z.infer<typeof claimSchema>;

// A claim arrives as an object or as a JSON string, for the reason evidence does
// (parseEvidence, src/job-outcomes.ts). Unlike evidence, a field that does not fit is
// refused rather than dropped, because the claim is the record.
export type ClaimInput = JobClaim | string | undefined;

export function parseClaim(input: unknown): { claim: JobClaim | undefined } | { error: string } {
  if (input === undefined || input === null) return { claim: undefined };
  let value: unknown = input;
  if (typeof input === "string") {
    const text = input.trim();
    // Blank is nothing sent, as for evidence.
    if (text.length === 0) return { claim: undefined };
    try {
      value = JSON.parse(text);
    } catch {
      return { error: `claim was sent as a string that is not JSON: ${text.slice(0, 120)}. Nothing was written.` };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "claim must be an object (or a JSON string of one). Nothing was written." };
  }
  const parsed = claimSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `claim${issue.path.length ? "." + issue.path.map(String).join(".") : ""}: ${issue.message}`);
    return { error: `claim was refused, not trimmed: ${problems.join("; ")}. Nothing was written.` };
  }
  return { claim: parsed.data };
}

// The claim-bearing arguments exactly as sent. Recorded whole in job_claims.raw so the
// structured columns can always be checked against what was actually said.
export interface ClaimRaw {
  evidence?: unknown;
  claim?: unknown;
  result_summary?: string;
  reason?: string;
  result_ref?: string | null;
  command?: string;
}

// evidence and claim may have arrived as JSON strings; raw keeps the parsed value, so
// the column is one JSON document rather than JSON with JSON inside it. A string that
// does not parse was refused before this runs, so it is kept as sent, not dropped.
function parsedValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function rawJson(raw: ClaimRaw): string {
  // JSON.stringify omits a key whose value is undefined, which is the rule: a key the
  // caller did not send is absent, not null.
  return JSON.stringify({
    evidence: parsedValue(raw.evidence),
    claim: parsedValue(raw.claim),
    result_summary: raw.result_summary,
    reason: raw.reason,
    result_ref: raw.result_ref ?? undefined,
    command: raw.command,
  });
}

export type ClaimAction = "complete" | "fail" | "block";

export interface JobClaimRow {
  job_id: string;
  action: ClaimAction;
  agent: string;
  namespace: string;
  raw: string;
  prs_opened_urls: string | null;
  prs_merged_urls: string | null;
  prs_opened: number | null;
  prs_merged: number | null;
  commits: number | null;
  files_changed: number | null;
  tests_added: number | null;
  tests_run: number | null;
  tests_passed: number | null;
  tests_failed: number | null;
  tests_result: string | null;
  deploy_state: string | null;
  files_touched: string | null;
  model_id: string | null;
  client_name: string | null;
  client_version: string | null;
  permission_mode: string | null;
  capsid_sha: string | null;
  recorded_at: string;
}

const listColumn = (list: readonly string[] | undefined): string | null => (list === undefined ? null : JSON.stringify([...list]));

/**
 * The job_claims row for one complete, fail or block call. Pure, and built from the
 * arguments before verifyEvidence runs, so nothing GitHub says can reach it: commits,
 * files_changed and tests_added are the driver's numbers as sent. An empty list is
 * stated ("said none") and stored as [] and 0; an absent one is NULL.
 */
export function claimRow(input: {
  job_id: string;
  action: ClaimAction;
  agent: string;
  namespace: string;
  raw: ClaimRaw;
  claim?: JobClaim;
  evidence?: JobEvidence;
  capsid_sha?: string | null;
  now: Date;
}): JobClaimRow {
  const { claim, evidence } = input;
  const opened = claim?.prs_opened ?? evidence?.prs;
  const merged = claim?.prs_merged;
  return {
    job_id: input.job_id,
    action: input.action,
    agent: input.agent,
    namespace: input.namespace,
    raw: rawJson(input.raw),
    prs_opened_urls: listColumn(opened),
    prs_merged_urls: listColumn(merged),
    prs_opened: opened === undefined ? null : opened.length,
    prs_merged: merged === undefined ? null : merged.length,
    commits: evidence?.commits ?? null,
    files_changed: evidence?.files_changed ?? null,
    tests_added: evidence?.tests_added ?? null,
    tests_run: claim?.tests?.run ?? null,
    tests_passed: claim?.tests?.passed ?? null,
    tests_failed: claim?.tests?.failed ?? null,
    tests_result: claim?.tests?.result ?? null,
    deploy_state: claim?.deploy_state ?? null,
    files_touched: listColumn(claim?.files_touched),
    model_id: claim?.versions?.model_id ?? null,
    client_name: claim?.versions?.client_name ?? null,
    client_version: claim?.versions?.client_version ?? null,
    permission_mode: claim?.versions?.permission_mode ?? null,
    capsid_sha: input.capsid_sha ?? null,
    recorded_at: input.now.toISOString(),
  };
}

// Append-only: migrations/0023's triggers refuse UPDATE and DELETE, so this INSERT is
// the only statement that ever touches the table from code.
export function claimStatement(db: D1Database, row: JobClaimRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO job_claims (job_id, action, agent, namespace, raw, prs_opened_urls, prs_merged_urls, prs_opened,
         prs_merged, commits, files_changed, tests_added, tests_run, tests_passed, tests_failed, tests_result,
         deploy_state, files_touched, model_id, client_name, client_version, permission_mode, capsid_sha, recorded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)`
    )
    .bind(
      row.job_id,
      row.action,
      row.agent,
      row.namespace,
      row.raw,
      row.prs_opened_urls,
      row.prs_merged_urls,
      row.prs_opened,
      row.prs_merged,
      row.commits,
      row.files_changed,
      row.tests_added,
      row.tests_run,
      row.tests_passed,
      row.tests_failed,
      row.tests_result,
      row.deploy_state,
      row.files_touched,
      row.model_id,
      row.client_name,
      row.client_version,
      row.permission_mode,
      row.capsid_sha,
      row.recorded_at
    );
}

// EVALUATIONS. The worker's own checks, named for OpenTelemetry's
// gen_ai.evaluation.result event. hidden_tests and scope_respected are in the table's
// vocabulary for a later evaluator (a model, a human); the worker writes none of them.
export const WORKER_EVALUATIONS = ["pr_merged", "prs_opened", "commits", "files_changed", "ci_green"] as const;
export type WorkerEvaluation = (typeof WORKER_EVALUATIONS)[number];

export type Agreement = "agree" | "disagree" | "unclaimed" | "unchecked";
export type ScoreLabel = "pass" | "fail" | "unknown";

export interface JobEvaluationRow {
  job_id: string;
  name: WorkerEvaluation;
  score_value: number | null;
  score_label: ScoreLabel;
  claimed: string | null;
  verified: string | null;
  agreement: Agreement;
  evaluator: "worker";
  evaluator_id: string;
  explanation: string | null;
  recorded_at: string;
}

/** Computed once, at write time, from the two values the row stores. */
export function agreementOf(claimed: number | null, verified: number | null): Agreement {
  if (claimed === null) return "unclaimed";
  if (verified === null) return "unchecked";
  return claimed === verified ? "agree" : "disagree";
}

export const workerEvaluatorId = (buildSha: string | null | undefined) => `capsid@${buildSha ?? "unknown"}`;

// The column holds a JSON array the row builder wrote, or NULL.
function urlsOf(column: string | null): string[] | null {
  if (column === null) return null;
  const parsed = JSON.parse(column) as unknown;
  return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : null;
}

const json = (value: number | null): string | null => (value === null ? null : JSON.stringify(value));

/**
 * One row per worker check, from the claim row and what verifyEvidence read off
 * GitHub. Pure. A value the Worker could not read is NULL with label unknown, and an
 * unstated claim is NULL with agreement unclaimed: neither is ever a 0 or a false.
 *
 * Only the pull requests in evidence.prs are read (verifyEvidence), so a URL the claim
 * names that evidence does not is unread, and a check over it is unchecked rather than
 * guessed.
 */
export function evaluationRows(
  claim: JobClaimRow,
  verdict: Pick<EvidenceVerdict, "github">,
  ctx: { evaluator_id: string; now: Date }
): JobEvaluationRow[] {
  const merged = verdict.github?.merged ?? {};
  const read = (url: string) => Object.hasOwn(merged, url);
  const row = (name: WorkerEvaluation, claimed: number | null, verified: number | null, label: ScoreLabel, explanation: string | null): JobEvaluationRow => ({
    job_id: claim.job_id,
    name,
    score_value: verified,
    score_label: verified === null ? "unknown" : label,
    claimed: json(claimed),
    verified: json(verified),
    agreement: agreementOf(claimed, verified),
    evaluator: "worker",
    evaluator_id: ctx.evaluator_id,
    explanation,
    recorded_at: ctx.now.toISOString(),
  });
  const unread = (urls: string[]) => urls.filter((u) => !read(u)).length;

  // pr_merged: the pull requests the claim says are merged, else the ones evidence
  // named. Verified is how many of them GitHub reads as merged, known only when every
  // one was read.
  const mergedClaim = urlsOf(claim.prs_merged_urls);
  const mergedSet = mergedClaim ?? urlsOf(claim.prs_opened_urls) ?? [];
  const mergedMissing = unread(mergedSet);
  const mergedVerified = mergedSet.length > 0 && mergedMissing === 0 ? mergedSet.filter((u) => merged[u]).length : null;
  const prMerged = row(
    "pr_merged",
    claim.prs_merged,
    mergedVerified,
    mergedVerified !== null && mergedVerified === mergedSet.length ? "pass" : "fail",
    mergedSet.length === 0
      ? "no pull request was named, so there was nothing to check"
      : mergedMissing > 0
        ? `${mergedMissing} of ${mergedSet.length} named pull requests could not be read (only evidence.prs is read)`
        : null
  );

  // prs_opened: every pull request the claim names exists on GitHub. Verified is the
  // count, known only when every one was read.
  const openedSet = urlsOf(claim.prs_opened_urls) ?? [];
  const openedMissing = unread(openedSet);
  const openedVerified = openedSet.length > 0 && openedMissing === 0 ? openedSet.length : null;
  const prsOpened = row(
    "prs_opened",
    claim.prs_opened,
    openedVerified,
    "pass",
    openedSet.length === 0
      ? "no pull request was named, so there was nothing to check"
      : openedMissing > 0
        ? `${openedMissing} of ${openedSet.length} named pull requests could not be read (only evidence.prs is read)`
        : null
  );

  // commits and files_changed: GitHub's sum over every named pull request, known only
  // when every one was read, against the driver's number as sent.
  const sums = "GitHub's sum is known only when every pull request in evidence.prs was read";
  const commitsVerified = verdict.github?.commits ?? null;
  const filesVerified = verdict.github?.files_changed ?? null;
  const commits = row("commits", claim.commits, commitsVerified, "pass", commitsVerified === null ? sums : null);
  const files = row("files_changed", claim.files_changed, filesVerified, "pass", filesVerified === null ? sums : null);

  // ci_green: no claim field says anything about CI, so the claim is NULL (unclaimed).
  const ciVerified = verdict.github?.ci_green ?? null;
  const ci = row(
    "ci_green",
    null,
    ciVerified,
    ciVerified === 1 ? "pass" : "fail",
    ciVerified === null ? "CI on the last named pull request's head was not read, or had not finished" : null
  );

  return [prMerged, prsOpened, commits, files, ci];
}

// claim_id is the claim row this batch inserted. Its id is not known before the batch
// runs, and the batch is one transaction, so the newest claim for the job is that row.
export function evaluationStatements(db: D1Database, rows: readonly JobEvaluationRow[]): D1PreparedStatement[] {
  return rows.map((row) =>
    db
      .prepare(
        `INSERT INTO job_evaluations (job_id, claim_id, name, score_value, score_label, claimed, verified, agreement,
           evaluator, evaluator_id, explanation, recorded_at)
         VALUES (?1, (SELECT MAX(id) FROM job_claims WHERE job_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(
        row.job_id,
        row.name,
        row.score_value,
        row.score_label,
        row.claimed,
        row.verified,
        row.agreement,
        row.evaluator,
        row.evaluator_id,
        row.explanation,
        row.recorded_at
      )
  );
}
