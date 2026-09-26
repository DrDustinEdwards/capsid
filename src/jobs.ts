import type { Env } from "./env";
import type { JobRow } from "./jobs-schema";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { guardedTransition } from "./jobs-transition";

// The work queue. The seat posts a job from a chat; a driver session on a machine
// claims it, does it, and reports back.
//
// Every transition is `UPDATE ... WHERE status = <expected> RETURNING id`, never
// meta.changes. D1's meta.changes is inflated by the FTS5 triggers on documents, and
// these batches carry a document write, so the count would be of the triggers as
// much as the row. No row back means somebody else got there first. The holder
// transitions (heartbeat, complete, fail, block) put the UPDATE in the same batch as
// its records, behind requireJobUnchanged (src/store-guards.ts), which aborts the
// whole batch when the row is not in the state the caller read.
//
// The row is the source of truth for status. The mirror document at
// <namespace>/jobs/<id>.md is rewritten in the same batch as every transition, so a
// reader who found the job through brief or search sees the state the table holds.
// It is a projection, and its body says so.
//
// The queue is split by who acts. jobs-claim.ts posts, lists and claims;
// jobs-holder.ts holds the transitions the claiming driver makes; jobs-seat.ts holds
// the ones made on a job the caller does not hold (admin fail, supersede, resume);
// jobs-mirror.ts writes the mirror document and audit row; jobs-transition.ts holds
// what they share. This module is the one other modules import from, and it keeps the
// lease sweep and the improve_status summary.

export { claimJob, listJobs, postJob } from "./jobs-claim";
export { blockJob, commandFromSummary, completeJob, failJob, heartbeatJob, RESUME_MARKER } from "./jobs-holder";
export { adminFailJob, failAsCaller, releaseJob, resumeJob, supersedeJob } from "./jobs-seat";
export type { JobResult } from "./jobs-transition";

// The lease sweep, run by the five-minute improve tick. A claim whose lease has
// expired goes back to queued, so a driver that died holds a job for at most
// JOB_LEASE_SECONDS rather than forever. The tick reports only the jobs whose batch
// committed.
//
// The mirror documents are rewritten in the same batch as each job's requeue: a job
// that reads "claimed by a session that is gone" in brief is the state this sweep
// exists to clear. Read, then one guarded batch per job, so a job whose records fail
// is not left requeued with none, and a job whose driver heartbeat in between
// (updated_at moved) is left alone.
export async function expireJobLeases(env: Env, now: Date): Promise<{ requeued: string[] }> {
  const stamp = now.toISOString();
  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status = 'claimed' AND lease_expires IS NOT NULL AND lease_expires < ?1"
  )
    .bind(stamp)
    .all<JobRow>();
  const requeued: string[] = [];
  // One job failing does not cost the others their requeue.
  for (const read of results ?? []) {
    try {
      const job: JobRow = { ...read, status: "queued", claimed_by: null, claimed_at: null, lease_expires: null, updated_at: stamp };
      const moved = await guardedTransition(env, read, [
        env.DB.prepare(
          `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires = NULL, updated_at = ?2
           WHERE id = ?1 AND status = 'claimed' AND lease_expires IS NOT NULL AND lease_expires < ?2 RETURNING id`
        ).bind(read.id, stamp),
        ...(await mirrorStatements(env.DB, job, "job-lease-expired", "improve-loop")),
        jobAudit(env.DB, "improve-loop", "job-lease-expired", job, { returned_to: "queued" }),
      ]);
      if (moved) requeued.push(read.id);
    } catch (err) {
      console.error(`JOB_LEASE_REQUEUE_FAILED ${read.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { requeued };
}

// The improve_status block. Counted per namespace, plus what a human has to look at:
// the blocked jobs, with the command each is waiting on. Blocked is the only status
// whose rows come back rather than a count, because a count of blocked jobs tells
// nobody what to run, and the console shows exactly these.
//
// done_today rather than done: a lifetime total only goes up and stops being
// information. What the seat wants to know is whether the queue moved today.
export interface JobsSummary {
  queued: number;
  claimed: number;
  blocked: number;
  done_today: number;
  // How often each job has hit a gate and how often a human sent it back. A job on
  // its third gate reads differently from one stuck at the same gate since it was
  // posted, and the count is what tells them apart.
  blocked_jobs: Array<{ id: string; title: string; waiting_on: string | null; blocked_times: number; resumed: number }>;
  // The claimed jobs and who holds each, so the seat can see a claim whose holder is
  // gone and release it rather than wait out the lease.
  claimed_jobs: Array<{ id: string; title: string; held_by: string | null; claimed_at: string | null; lease_expires: string | null }>;
}

export async function jobsSummary(db: D1Database, namespace: string, now: Date): Promise<JobsSummary> {
  const day = now.toISOString().slice(0, 10);
  const counts = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status IN ('queued', 'claimed', 'blocked') GROUP BY status`
    )
    .bind(namespace)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((counts.results ?? []).map((r) => [r.status, r.n]));
  // substr, not a range: updated_at is an ISO string here and datetime('now') from the
  // table default, and the two agree only on the first ten characters.
  const doneToday = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status = 'done' AND substr(updated_at, 1, 10) = ?2`
    )
    .bind(namespace, day)
    .first<{ n: number }>();
  const blocked = await db
    .prepare(
      `SELECT id, title, result_summary, blocked_count, resumed_count FROM jobs
       WHERE namespace = ?1 AND status = 'blocked' ORDER BY updated_at DESC LIMIT 20`
    )
    .bind(namespace)
    .all<{ id: string; title: string; result_summary: string | null; blocked_count: number; resumed_count: number }>();
  const claimed = await db
    .prepare(
      `SELECT id, title, claimed_by, claimed_at, lease_expires FROM jobs
       WHERE namespace = ?1 AND status = 'claimed' ORDER BY updated_at DESC LIMIT 20`
    )
    .bind(namespace)
    .all<{ id: string; title: string; claimed_by: string | null; claimed_at: string | null; lease_expires: string | null }>();
  return {
    queued: byStatus.get("queued") ?? 0,
    claimed: byStatus.get("claimed") ?? 0,
    blocked: byStatus.get("blocked") ?? 0,
    done_today: doneToday?.n ?? 0,
    blocked_jobs: (blocked.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      waiting_on: r.result_summary,
      blocked_times: r.blocked_count,
      resumed: r.resumed_count,
    })),
    claimed_jobs: (claimed.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      held_by: r.claimed_by,
      claimed_at: r.claimed_at,
      lease_expires: r.lease_expires,
    })),
  };
}
