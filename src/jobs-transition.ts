import type { Env } from "./env";
import type { Agent } from "./agents";
import { JOB_LEASE_SECONDS, missingForRecord, type JobRow } from "./jobs-schema";
import { isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import { loadRecordRows, recordFor } from "./agent-record";
import type { JobOutcomeRow } from "./job-outcomes";
import type { JobListRow } from "./jobs-claim";
import { jobAudit, mirrorStatements, type ResumeNote } from "./jobs-mirror";

// What every job transition shares: the result shape, the refusal, the row read, the
// guarded batch every transition commits through, and the checks more than one of
// claim, holder and seat make. The queue's rules are stated in src/jobs.ts.

// claimed_by carries the same shape as audit_log.actor (migrations/0006), so one
// query joins a job to what its driver did. A minted agent speaks that vocabulary as
// `agent:<name>` (agentActor in src/agents-schema.ts), and the name is unique in the
// agents table and never reused, so the string identifies exactly one credential.
const ACTOR_SHAPE = /^(github:|opkey:|agent:)/;

export function actorShapeRefusal(action: string, actor: string): JobResult | null {
  if (ACTOR_SHAPE.test(actor)) return null;
  return refuse(
    action,
    `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login, an opkey: fingerprint, or an agent: name.`
  );
}

// The job a caller holds, if any. A caller holds at most one (claimJob).
export async function heldClaim(db: D1Database, actor: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1").bind(actor).first<JobRow>();
}

// The seat is identified by admin or can_merge, for supersede and for resume. An
// agent's kind is descriptive and not authorizing (src/agents-schema.ts); can_merge is
// the flag the seat holds and no driver does.
export function callerIsSeat(agent: Agent): boolean {
  return agent.admin || agent.scopes.flags.can_merge;
}

export interface JobResult {
  ok: boolean;
  action: string;
  job?: JobRow;
  jobs?: Array<JobListRow | JobRow>;
  truncated?: boolean;
  note?: string;
  refusal?: string;
  // The outcome row this transition wrote, returned so the driver sees what the
  // Worker checked rather than assuming its own numbers were taken. `notes` names
  // every verification that could not run, which separates a count nobody checked
  // from a count nobody could check.
  outcome?: { row: JobOutcomeRow; notes: string[] };
  // The latest resume's reason, for a job resumed at least once. See
  // latestResumeNote in src/jobs-mirror.ts.
  resume_note?: ResumeNote;
}

export function refuse(action: string, refusal: string): JobResult {
  return { ok: false, action, refusal };
}

export const leaseUntil = (now: Date) => new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString();

export async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// The one path that fails a job that cannot be handed over: a corrupt requirement or
// a bad signature at claim, a bad signature at resume. The UPDATE, the mirror and the
// audit row are one guarded batch, so they commit only when the row is still as the
// caller read it. Without the guard, a job another driver had claimed meanwhile would
// get a mirror and an audit row saying it failed while its row said claimed. When the
// guard aborts, the caller gets the current row to refuse with.
export async function markJobFailed(
  env: Env,
  job: JobRow,
  fromStatus: "queued" | "blocked",
  summary: string,
  auditAction: string,
  actor: string,
  auditParams: Record<string, unknown>,
  now: Date
): Promise<{ failed: true } | { failed: false; current: JobRow | null }> {
  const failed = { ...job, status: "failed" as const, result_summary: summary, lease_expires: null, updated_at: now.toISOString() };
  const committed = await guardedTransition(env, job, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = ?4 RETURNING id`
    ).bind(job.id, summary, now.toISOString(), fromStatus),
    ...(await mirrorStatements(env.DB, failed, auditAction, actor)),
    jobAudit(env.DB, actor, auditAction, failed, auditParams),
  ]);
  if (!committed) return { failed: false, current: await readJob(env.DB, job.id) };
  return { failed: true };
}

// Every transition and its records are one batch. Committing the UPDATE alone and
// writing the mirror and audit row in a second batch would let a throw in between
// leave a moved row with no record of the move.
//
// `read` is the row the caller decided on. requireJobUnchanged, first in the batch,
// aborts the whole batch unless the row still has that status, holder and updated_at,
// and D1 runs a batch as one transaction, so the UPDATE and every record built from
// `read` commit together or not at all. Returns false when the guard aborted, which
// means nothing was written and the row changed since `read`.
export async function guardedTransition(env: Env, read: JobRow, statements: D1PreparedStatement[]): Promise<boolean> {
  try {
    await env.DB.batch([requireJobUnchanged(env.DB, read.id, read.status, read.claimed_by, read.updated_at), ...statements]);
    return true;
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return false;
  }
}

/** The refusal for a job markJobFailed found had already moved. */
export function movedBeforeFailing(action: string, id: string, current: JobRow | null, why: string): JobResult {
  return refuse(
    action,
    `${id} ${why}, but it changed before it could be marked failed: it is now ${current?.status ?? "gone"}${current?.claimed_by ? `, held by ${current.claimed_by}` : ""}. Nothing was written.`
  );
}

// The track-record bar, checked at claim (migrations/0011).
//
// Read only when a job sets one, which is rare. The record is computed from every
// outcome row, so making every claim pay for that read would put a table scan in
// front of the queue's hottest path.
//
// It goes through recordFor, the same function improve_status and the console call,
// so the bar a claim is measured against is the number a human can read on the page.
// `null` for namespaces because the improve-loop columns play no part in this
// comparison, and computing them here would attribute a namespace's attempts to
// whichever credential happened to be asking.
export async function recordShortfall(db: D1Database, actor: string, job: JobRow): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db), null), job.min_record);
}

// The corrections budget is a property of the work, not of the row.
//
// corrections_count lives on a row, and the unique open-title index covers `queued`,
// `claimed` and `blocked` (migrations/0019) but not `failed`, so a failed job leaves
// (namespace, title) free to be posted again. The new row starts at 0, and a per-row
// cap would count how many times a row existed rather than how many times the work
// had been sent back. So the count is per (namespace, title).
//
// Summed across every row for that work, whatever its status, and the current row is
// one of them. Unindexed on purpose: jobs is a single-user queue of a few hundred rows
// at most, and the only index on (namespace, title) is the partial one, which does not
// cover finished rows.
//
// Fails closed. A read that throws, or a SUM that is not a finite number, returns
// NaN, and atCorrectionCap treats a budget it cannot read as a budget already spent.
export async function correctionsForWork(db: D1Database, namespace: string, title: string): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT COALESCE(SUM(corrections_count), 0) AS spent FROM jobs WHERE namespace = ?1 AND title = ?2")
      .bind(namespace, title)
      .first<{ spent: number }>();
    const spent = row?.spent;
    return typeof spent === "number" && Number.isFinite(spent) ? spent : Number.NaN;
  } catch (err) {
    console.error(`CORRECTIONS_READ_FAILED ${namespace}/${title}: ${err instanceof Error ? err.message : String(err)}`);
    return Number.NaN;
  }
}
