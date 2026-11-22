import { isQuestionSummary } from "./jobs-holder-block";
import { checkJobText, type SignatureCheck } from "./job-signing";

// The work queue. The seat posts a job from a chat; a driver session on a machine claims it,
// does it, and reports back.
//
// Every transition is `UPDATE ... WHERE status = <expected> RETURNING id`, never meta.changes:
// D1's count is inflated by the FTS5 triggers on documents, and these batches carry a document
// write. No row back means somebody else got there first. The holder transitions (complete,
// fail, block) put the UPDATE in the same batch as its records, behind requireJobUnchanged
// (src/store-guards.ts), which aborts the batch when the row is not in the state the caller read.
//
// The row is the source of truth for status. The mirror document at <namespace>/jobs/<id>.md is
// rewritten in the same batch as every transition, so a reader who found the job through
// capsid_start_session or capsid_find_docs sees the table's state. It is a projection.
//
// Split by who acts: jobs-claim.ts posts and claims (jobs-claim-list.ts lists); jobs-holder.ts the claiming
// driver's transitions; jobs-seat.ts those on a job the caller does not hold; jobs-edit.ts and
// jobs-park.ts the seat's edit and parking; jobs-begin.ts the started label; jobs-mirror.ts the
// mirror and audit row; jobs-transition.ts what they share. This module is the one others import
// from, and keeps the capsid_read_status action status summary.

export { claimJob, postJob } from "./jobs-claim";
export { listJobs } from "./jobs-claim-list";
export { completeJob } from "./jobs-holder";
export { blockJob, commandFromSummary, failJob, RESUME_MARKER } from "./jobs-holder-block";
export {
  adminFailJob,
  completeAsCaller,
  failAsCaller,
  recordAsCaller,
  releaseJob,
} from "./jobs-seat";
export { resumeJob } from "./jobs-seat-resume";
export { supersedeJob } from "./jobs-seat-supersede";
export { editJob, jobVersions } from "./jobs-edit";
export { parkJob, returnDueParked, unparkJob } from "./jobs-park";
export { beginJob } from "./jobs-begin";
export type { JobResult } from "./jobs-transition";

// The capsid_read_status action status block: counted per namespace, plus what a human has to look
// at. Blocked is the only status whose rows come back rather than a count (with the command each
// is waiting on), since a count tells nobody what to run. done_today rather than done: a lifetime
// total only goes up and stops being information.
export interface JobsSummary {
  queued: number;
  claimed: number;
  blocked: number;
  done_today: number;
  // How often each job has hit a gate and how often a human sent it back. A job on
  // its third gate reads differently from one stuck at the same gate since it was
  // posted, and the count is what tells them apart.
  // command_signature says whether waiting_on is what the holder's block wrote
  // (src/job-signing.ts); a "mismatch" summary is withheld.
  // question is true for a block that asks something rather than waits on a command run
  // (capsid_work_jobs action block with question: true); the seat answers it with a resume note.
  blocked_jobs: Array<{
    id: string;
    title: string;
    waiting_on: string | null;
    question: boolean;
    command_signature: SignatureCheck | null;
    blocked_times: number;
    resumed: number;
  }>;
  // The claimed jobs and who holds each, so the seat can see a claim whose holder is
  // gone and release it.
  claimed_jobs: Array<{
    id: string;
    title: string;
    held_by: string | null;
    claimed_at: string | null;
  }>;
}

export async function jobsSummary(
  db: D1Database,
  namespace: string,
  now: Date,
  secret?: string,
): Promise<JobsSummary> {
  const day = now.toISOString().slice(0, 10);
  const counts = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status IN ('queued', 'claimed', 'blocked') GROUP BY status`,
    )
    .bind(namespace)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((counts.results ?? []).map((r) => [r.status, r.n]));
  // substr, not a range: updated_at is an ISO string here and datetime('now') from the
  // table default, and the two agree only on the first ten characters.
  const doneToday = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status = 'done' AND substr(updated_at, 1, 10) = ?2`,
    )
    .bind(namespace, day)
    .first<{ n: number }>();
  const blocked = await db
    .prepare(
      `SELECT id, title, result_summary, summary_sig, blocked_count, resumed_count FROM jobs
       WHERE namespace = ?1 AND status = 'blocked' ORDER BY updated_at DESC LIMIT 20`,
    )
    .bind(namespace)
    .all<{
      id: string;
      title: string;
      result_summary: string | null;
      summary_sig: string | null;
      blocked_count: number;
      resumed_count: number;
    }>();
  const blockedRows = blocked.results ?? [];
  const checks = await Promise.all(
    blockedRows.map((r) =>
      r.result_summary === null
        ? Promise.resolve(null)
        : checkJobText(secret, "summary", r.id, { summary: r.result_summary }, r.summary_sig),
    ),
  );
  const claimed = await db
    .prepare(
      `SELECT id, title, claimed_by, claimed_at FROM jobs
       WHERE namespace = ?1 AND status = 'claimed' ORDER BY updated_at DESC LIMIT 20`,
    )
    .bind(namespace)
    .all<{ id: string; title: string; claimed_by: string | null; claimed_at: string | null }>();
  return {
    queued: byStatus.get("queued") ?? 0,
    claimed: byStatus.get("claimed") ?? 0,
    blocked: byStatus.get("blocked") ?? 0,
    done_today: doneToday?.n ?? 0,
    blocked_jobs: blockedRows.map((r, i) => ({
      id: r.id,
      title: r.title,
      waiting_on:
        checks[i] === "mismatch"
          ? "WITHHELD: this summary's signature does not match, so it was changed after the block wrote it. Do not run its command."
          : r.result_summary,
      question: checks[i] !== "mismatch" && isQuestionSummary(r.result_summary),
      command_signature: checks[i],
      blocked_times: r.blocked_count,
      resumed: r.resumed_count,
    })),
    claimed_jobs: (claimed.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      held_by: r.claimed_by,
      claimed_at: r.claimed_at,
    })),
  };
}
