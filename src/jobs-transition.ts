import type { Env } from "./env";
import type { Agent } from "./agents";
import { missingForRecord, type JobRow, type StartedNotice } from "./jobs-schema";
import { isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import { loadRecordRows, recordFor } from "./agent-record";
import type { JobOutcomeRow } from "./job-outcomes";
import type { JobListRow } from "./jobs-claim";
import type { OverlapReport } from "./job-overlaps";
import type { JobVersion } from "./jobs-edit";
import { jobAudit, mirrorStatements, type ResumeNote } from "./jobs-mirror";
import { logEvent } from "@dustinedwards/site-runtime/log";

// What every job transition shares: the result shape, the refusal, the row read, the
// guarded batch every transition commits through, and the checks more than one of
// claim, holder and seat make. The queue's rules are stated in src/jobs.ts.

// claimed_by carries the same shape as audit_log.actor (migrations/0006), so one
// query joins a job to what its driver did. A minted agent speaks that vocabulary as
// `agent:<name>` (agentActor in src/agents-schema.ts), and the name is unique in the
// agents table and never reused, so the string identifies exactly one credential. The
// admin is `access:<email>` on the MCP login since it moved to Cloudflare Access
// (docs/auth.md, 2026-09-27) and `github:<login>` on rows the old console wrote before it moved to Access.
const ACTOR_SHAPE = /^(access:|github:|opkey:|agent:)/;

export function actorShapeRefusal(action: string, actor: string): JobResult | null {
  if (ACTOR_SHAPE.test(actor)) return null;
  return refuse(
    action,
    `'${actor}' is not a caller identity this queue can hold a claim for. A claim is recorded against an access: email, a github: login, an opkey: fingerprint, or an agent: name.`
  );
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
  // post and edit: what the body lacks that a session acts best with (src/job-body-check.ts).
  // A warning never refuses.
  warnings?: string[];
  refusal?: string;
  // The outcome row this transition wrote, returned so the driver sees what the
  // Worker checked rather than assuming its own numbers were taken. `notes` names
  // every verification that could not run, which separates a count nobody checked
  // from a count nobody could check.
  outcome?: { row: JobOutcomeRow; notes: string[] };
  // The latest resume's reason, for a job resumed at least once. See
  // latestResumeNote in src/jobs-mirror.ts.
  resume_note?: ResumeNote;
  // Every resume note, newest first (the newest is resume_note), within a byte cap; and how
  // many the answer leaves out. claim and list for one id (src/jobs-mirror.ts).
  resume_notes?: ResumeNote[];
  resume_notes_dropped?: number;
  // block and complete: the other open pull requests that change the same files as the one
  // this call named, or why that could not be checked (src/job-overlaps.ts). Absent when the
  // call named no pull request of the namespace's repo.
  overlaps?: OverlapReport;
  // A job somebody marked started (src/jobs-begin.ts): who and when, so a second session
  // reading it knows. begin, claim and list for one id return it. Never a refusal.
  started?: StartedNotice;
  // claim: the model Capsid recommends for this job, why, and how to follow it
  // (src/model-routing.ts), and a note when the pull request it carries could not be read.
  routing?: Record<string, unknown>;
  routing_note?: string;
  // list view "models": the learning table.
  models?: Record<string, unknown>;
  // edit, and list for one named id to a caller holding write: the versions earlier
  // edits replaced, newest first (src/jobs-edit.ts, migrations/0033).
  versions?: JobVersion[];
  // fire: the session the routine started (src/routine-fire.ts). Either field is null
  // when Anthropic's answer did not carry it in the expected shape.
  session?: { id: string | null; url: string | null };
  // routine: a namespace's routine as Capsid holds it. The token is never returned, only
  // the secret's name and whether it is set.
  routine?: { namespace: string; routine_id: string | null; token_secret: string; token_set: boolean };
}

export function refuse(action: string, refusal: string): JobResult {
  return { ok: false, action, refusal };
}

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
  const failed = { ...job, status: "failed" as const, result_summary: summary, updated_at: now.toISOString() };
  const committed = await guardedTransition(env, job, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, summary_sig = NULL, updated_at = ?3
       WHERE id = ?1 AND status = ?4 RETURNING id`
    ).bind(job.id, summary, now.toISOString(), fromStatus),
    ...(await mirrorStatements(env, failed, auditAction, actor)),
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
// It goes through recordFor, the same function capsid_run_improve action status and the Portal call,
// so the bar a claim is measured against is the number a human can read on the page.
export async function recordShortfall(db: D1Database, actor: string, job: JobRow): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db)), job.min_record);
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
    logEvent("CORRECTIONS_READ_FAILED", { message: `CORRECTIONS_READ_FAILED ${namespace}/${title}: ${err instanceof Error ? err.message : String(err)}` }, { level: "error" });
    return Number.NaN;
  }
}
