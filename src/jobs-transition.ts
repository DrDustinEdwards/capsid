import type { Env } from "./env";
import type { Agent } from "./agents";
import { missingForRecord, type JobRow, type StartedNotice } from "./jobs-schema";
import { isMissingRowAbort, requireJobUnchanged } from "./store-guards";
import { loadRecordRows, recordFor } from "./agent-record";
import type { JobOutcomeRow } from "./job-outcomes";
import type { JobListRow } from "./jobs-claim-list";
import type { OverlapReport } from "./job-overlaps";
import type { JobVersion } from "./jobs-edit";
import { jobAudit, mirrorStatements, type ResumeNote } from "./jobs-mirror";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";

// What every job transition shares: the result shape, the refusal, the row read, the guarded batch
// every transition commits through, and the checks more than one of claim, holder and seat make.
// The queue's rules are stated in src/jobs.ts.

// A minted agent speaks that vocabulary as `agent:<name>` (agentActor in src/agents-schema.ts),
// and the name is unique in the agents table and never reused, so the string identifies exactly
// one credential.
const ACTOR_SHAPE = /^(access:|github:|agent:)/;

export function actorShapeRefusal(action: string, actor: string): JobResult | null {
  if (ACTOR_SHAPE.test(actor)) return null;
  return refuse(
    action,
    `'${actor}' is not a caller identity this queue can hold a claim for. A claim is recorded against an access: email, a github: login or an agent: name.`,
  );
}

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
  // post and edit: what the body lacks that a session acts best with (src/job-body-check.ts). A
  // warning never refuses.
  warnings?: string[];
  refusal?: string;
  // The outcome row this transition wrote, returned so the driver sees what the Worker checked
  // rather than assuming its own numbers were taken. `notes` names every verification that could not
  // run, which separates a count nobody checked from a count nobody could check.
  outcome?: { row: JobOutcomeRow; notes: string[] };
  resume_note?: ResumeNote;
  // Every resume note, newest first (the newest is resume_note), within a byte cap; and how many the
  // answer leaves out. claim and list for one id (src/jobs-mirror.ts).
  resume_notes?: ResumeNote[];
  resume_notes_dropped?: number;
  overlaps?: OverlapReport;
  // A job somebody marked started (src/jobs-begin.ts): who and when, so a second session reading it
  // knows. begin, claim and list for one id return it. Never a refusal.
  started?: StartedNotice;
  routing?: Record<string, unknown>;
  routing_note?: string;
  models?: Record<string, unknown>;
  versions?: JobVersion[];
}

export function refuse(action: string, refusal: string): JobResult {
  return { ok: false, action, refusal };
}

export async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// The UPDATE, the mirror and the audit row are one guarded batch, so they commit only when the row
// is still as the caller read it. Without the guard, a job another driver had claimed meanwhile
// would get a mirror and an audit row saying it failed while its row said claimed.
export async function markJobFailed(
  env: Env,
  job: JobRow,
  fromStatus: "queued" | "blocked",
  summary: string,
  auditAction: string,
  actor: string,
  auditParams: Record<string, unknown>,
  now: Date,
): Promise<{ failed: true } | { failed: false; current: JobRow | null }> {
  const failed = {
    ...job,
    status: "failed" as const,
    result_summary: summary,
    updated_at: now.toISOString(),
  };
  const committed = await guardedTransition(env, job, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, summary_sig = NULL, updated_at = ?3
       WHERE id = ?1 AND status = ?4 RETURNING id`,
    ).bind(job.id, summary, now.toISOString(), fromStatus),
    ...(await mirrorStatements(env, failed, auditAction, actor)),
    jobAudit(env.DB, actor, auditAction, failed, auditParams),
  ]);
  if (!committed) return { failed: false, current: await readJob(env.DB, job.id) };
  return { failed: true };
}

// `read` is the row the caller decided on. requireJobUnchanged, first in the batch, aborts it all
// unless the row still has that status, holder and updated_at, and D1 runs a batch as one
// transaction. Returns false when the guard aborted: nothing was written and the row changed.
export async function guardedTransition(
  env: Env,
  read: JobRow,
  statements: D1PreparedStatement[],
): Promise<boolean> {
  try {
    await env.DB.batch([
      requireJobUnchanged(env.DB, read.id, read.status, read.claimed_by, read.updated_at),
      ...statements,
    ]);
    return true;
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return false;
  }
}

export function movedBeforeFailing(
  action: string,
  id: string,
  current: JobRow | null,
  why: string,
): JobResult {
  return refuse(
    action,
    `${id} ${why}, but it changed before it could be marked failed: it is now ${current?.status ?? "gone"}${current?.claimed_by ? `, held by ${current.claimed_by}` : ""}. Nothing was written.`,
  );
}

// Read only when a job sets one (rare): the record is computed from every outcome row, and making
// every claim pay for it would put a table scan on the queue's hottest path.
export async function recordShortfall(
  db: D1Database,
  actor: string,
  job: JobRow,
): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db)), job.min_record);
}

// Fails closed: a read that throws, or a SUM that is not a finite number, returns NaN, and
// atCorrectionCap treats a budget it cannot read as already spent.
export async function correctionsForWork(
  db: D1Database,
  namespace: string,
  title: string,
): Promise<number> {
  try {
    const row = await db
      .prepare(
        "SELECT COALESCE(SUM(corrections_count), 0) AS spent FROM jobs WHERE namespace = ?1 AND title = ?2",
      )
      .bind(namespace, title)
      .first<{ spent: number }>();
    const spent = row?.spent;
    return typeof spent === "number" && Number.isFinite(spent) ? spent : Number.NaN;
  } catch (err) {
    logEvent(
      "CORRECTIONS_READ_FAILED",
      {
        message: `CORRECTIONS_READ_FAILED ${namespace}/${title}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
    return Number.NaN;
  }
}
