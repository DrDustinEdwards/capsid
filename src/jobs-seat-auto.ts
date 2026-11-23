// Where a resumed job goes, and the resume that follows a merge.
import type { Env } from "./env";
import { type JobRow } from "./jobs-schema";
import { jobAudit, mirrorStatements, resumeNoteFields, type ResumeNote } from "./jobs-mirror";
import { signJobText } from "./job-signing";
import { actorKind, touchStatement } from "./job-touches";
import { guardedTransition } from "./jobs-transition";

// A minted agent's actor is `agent:<name>`: one credential, one driver. The admin
// identity (`access:<email>`, or `github:<login>` from the old console) is shared by whatever
// sessions connect with it. A retired operator key (`opkey:<fingerprint>`) is left only on older
// audit_log rows.
const isMintedActor = (actor: string): boolean => actor.startsWith("agent:");

/** Where a resume sends a blocked job: back to `holder` (toQueue null), or to the queue
 *  with the reason, when the holder cannot act on it. With take the resumer acquires the
 *  job, so it never goes to the queue. resumeJob acts on it and the Portal's preview
 *  (src/controls.ts) states it, so the two agree. */
export async function resumeDestination(
  env: Env,
  holder: string,
  job: JobRow,
  take: boolean,
): Promise<{ toQueue: string | null }> {
  const id = job.id;
  const db = env.DB;
  const toQueue: string | null = take
    ? null
    : !isMintedActor(holder)
      ? `${holder} is a shared identity rather than one driver's session, so ${id} went back to the queue for the next free session.`
      : (await isRevokedActor(db, holder))
        ? `${holder} is revoked and can no longer claim, so ${id} went back to the queue for the next session.`
        : null;
  return { toQueue };
}

/** A minted agent whose key was revoked: it can never act on a job handed back to it. */
async function isRevokedActor(db: D1Database, actor: string): Promise<boolean> {
  if (!actor.startsWith("agent:")) return false;
  const row = await db
    .prepare(
      "SELECT revoked_at FROM agents WHERE name = ?1 UNION ALL SELECT revoked_at FROM agents_archive WHERE name = ?1",
    )
    .bind(actor.slice("agent:".length))
    .first<{ revoked_at: string | null }>();
  return row?.revoked_at != null;
}

/** The actor that returns a blocked job whose pull requests have all merged
 *  (src/merge-resume.ts). A system actor, not a caller: it holds no grant, passes no
 *  checkScope, and can do exactly what autoResumeJob does. */
export const MERGE_RESUME_ACTOR = "system:merge-resume";

/** Resume a BLOCKED job to its holder, or to the queue when the holder cannot act, on
 *  the strength of one fact the caller has read: every pull request the job names has
 *  merged. Never completes, never takes the claim, never approves a gate command; the
 *  holder's own claim still finishes the job. Returns false when the job moved between
 *  the caller's read and this write, in which case nothing was written. */
export async function autoResumeJob(
  env: Env,
  now: Date,
  job: JobRow,
  note: string,
): Promise<{ resumed: boolean; to: "holder" | "queue" }> {
  const holder = job.claimed_by;
  if (job.status !== "blocked" || !holder) return { resumed: false, to: "holder" };
  // Without take, a holder that cannot take the job back already yields toQueue.
  const { toQueue } = await resumeDestination(env, holder, job, false);
  const queued = toQueue !== null;
  const reason = "every pull request this job names has merged";
  const next: JobRow = {
    ...job,
    status: queued ? "queued" : "claimed",
    claimed_by: queued ? null : holder,
    resumed_count: job.resumed_count + 1,
    updated_at: now.toISOString(),
  };
  const noteSig = await signJobText(
    env.IMPROVE_SCORE_SECRET,
    "resume-note",
    job.id,
    resumeNoteFields(reason, note, MERGE_RESUME_ACTOR),
  );
  const resumeNote: ResumeNote = {
    reason,
    note,
    by: MERGE_RESUME_ACTOR,
    at: now.toISOString(),
    signature: noteSig ? "verified" : "unconfigured",
  };
  const kind = actorKind(MERGE_RESUME_ACTOR);
  const won = await guardedTransition(env, job, [
    env.DB.prepare(
      `UPDATE jobs SET status = ?5, claimed_by = ?2,
         resumed_count = resumed_count + 1, corrections_count = corrections_count + ?4, updated_at = ?3
       WHERE id = ?1 AND status = 'blocked' RETURNING id`,
    ).bind(job.id, next.claimed_by, now.toISOString(), 0, next.status),
    ...(await mirrorStatements(env, next, "job-resumed", MERGE_RESUME_ACTOR, resumeNote)),
    jobAudit(env.DB, MERGE_RESUME_ACTOR, "job-resumed", next, {
      approved: reason,
      note,
      ...(noteSig ? { sig: noteSig } : {}),
      held_by: next.claimed_by,
      ...(queued ? { returned_to: "queued", previous_holder: holder } : {}),
      resumed_count: next.resumed_count,
    }),
    touchStatement(env.DB, {
      job_id: job.id,
      namespace: job.namespace,
      kind: "resume",
      actor: MERGE_RESUME_ACTOR,
      actor_kind: kind,
      detail: { reason, ...(queued ? { returned_to: "queued" } : {}) },
      sinceGate: true,
      at: now.toISOString(),
    }),
    touchStatement(env.DB, {
      job_id: job.id,
      namespace: job.namespace,
      kind: "note",
      actor: MERGE_RESUME_ACTOR,
      actor_kind: kind,
      detail: { note },
      sinceGate: false,
      at: now.toISOString(),
    }),
  ]);
  return { resumed: won, to: queued ? "queue" : "holder" };
}
