import type { Env } from "./env";
import type { Agent } from "./agents";
import { OPEN_JOB_STATUSES, outsideJobNamespace, type JobRow } from "./jobs-schema";
import { signedJobBody } from "./jobs-claim";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { callerIsSeat, guardedTransition, readJob, refuse, type JobResult } from "./jobs-transition";

// Edit: the seat correcting a job that nobody is working (job_4ef99d687805, Dustin
// 2026-10-07). Before it, a posted job could not be changed, because its body is
// signed, so every correction was a supersede and a repost.
//
// Only the seat (callerIsSeat: the admin or a can_merge caller), never a driver: a
// driver that could rewrite a job's body could hand itself a different prompt under a
// signature this Worker made. Only while the job is queued or blocked. A claimed job is
// being worked to the body it was handed, and a finished one is history.
//
// A new body goes through signedJobBody, the path post uses, so it is refused for what
// post refuses and signed as post signs it, and claim and resume verify it as they
// verify a posted body. The version the edit replaces is copied to job_versions
// (migrations/0033) in the same guarded batch as the UPDATE, the mirror and the audit
// row, so a version is never lost and never kept for an edit that did not commit.

const EDITABLE_STATUSES: readonly JobRow["status"][] = ["queued", "blocked"];

/** One earlier version of a job, as an edit replaced it. */
export interface JobVersion {
  edited_by: string;
  edited_at: string;
  title: string;
  // As it was stored: the signed text, frontmatter and all.
  body: string;
  priority: number;
  gate_required: number;
}

const JOB_VERSIONS_MAX = 100;

/** A job's earlier versions, newest first: what list returns for one named id to a
 *  caller holding write. */
export async function jobVersions(db: D1Database, jobId: string): Promise<JobVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT edited_by, edited_at, title, body, priority, gate_required FROM job_versions
       WHERE job_id = ?1 ORDER BY id DESC LIMIT ?2`
    )
    .bind(jobId, JOB_VERSIONS_MAX)
    .all<JobVersion>();
  return results ?? [];
}

/** The other open job holding a (namespace, title), if any. */
async function openTitleHolder(db: D1Database, namespace: string, title: string, id: string): Promise<{ id: string; status: string } | null> {
  const placeholders = OPEN_JOB_STATUSES.map((_, i) => `?${i + 4}`).join(", ");
  return db
    .prepare(`SELECT id, status FROM jobs WHERE namespace = ?1 AND title = ?2 AND id != ?3 AND status IN (${placeholders}) LIMIT 1`)
    .bind(namespace, title, id, ...OPEN_JOB_STATUSES)
    .first<{ id: string; status: string }>();
}

function collision(namespace: string, title: string, holder: { id: string; status: string } | null): JobResult {
  const named = holder ? `: ${holder.id} is ${holder.status}` : "";
  return refuse("edit", `${namespace} already has another open job titled '${title}'${named}. One open job per (namespace, title), so the edit was refused and nothing was written.`);
}

export async function editJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { title?: string; body?: string; priority?: number; gate_required?: boolean }
): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse(
      "edit",
      `${agent.actor} cannot edit a job. Changing a posted job is the seat's act, and this caller holds neither the admin identity nor can_merge.`
    );
  }
  if (args.title === undefined && args.body === undefined && args.priority === undefined && args.gate_required === undefined) {
    return refuse("edit", "edit needs at least one of title, body, priority and gate_required.");
  }
  const title = args.title?.trim();
  if (args.title !== undefined && !title) {
    return refuse("edit", "a job needs a title: it is how the queue refuses a duplicate while one is still open.");
  }
  let signed: string | undefined;
  if (args.body !== undefined) {
    const checked = await signedJobBody(env, args.body);
    if (!checked.ok) return refuse("edit", checked.problem);
    signed = checked.signed;
  }

  const current = await readJob(env.DB, id);
  if (!current) return refuse("edit", `no job ${id}.`);
  // The job's own namespace: the tool's check saw only the namespace argument, which an
  // id-based call may omit.
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("edit", `${agent.actor} cannot edit ${id} ('${current.title}'): ${outside}`);
  if (!EDITABLE_STATUSES.includes(current.status)) {
    return refuse(
      "edit",
      `${id} is ${current.status}${current.claimed_by && current.status === "claimed" ? ` (held by ${current.claimed_by})` : ""}. Edit changes a queued or blocked job; ${current.status === "claimed" ? "a claimed job is being worked to the body it was handed, so block or release it first" : "a finished job is not rewritten"}.`
    );
  }

  const edited: JobRow = {
    ...current,
    title: title ?? current.title,
    body: signed ?? current.body,
    priority: args.priority ?? current.priority,
    gate_required: args.gate_required === undefined ? current.gate_required : args.gate_required ? 1 : 0,
    updated_at: now.toISOString(),
  };
  if (edited.title !== current.title) {
    const holder = await openTitleHolder(env.DB, current.namespace, edited.title, id);
    if (holder) return collision(current.namespace, edited.title, holder);
  }
  const changed = (["title", "body", "priority", "gate_required"] as const).filter((field) => edited[field] !== current[field]);
  // The same body signs to the same text, so an edit that restates the job is caught here
  // rather than kept as a version identical to the row.
  if (changed.length === 0) return refuse("edit", `${id} already reads that way. Nothing was written.`);

  let won: boolean;
  try {
    won = await guardedTransition(env, current, [
      env.DB.prepare(
        `INSERT INTO job_versions (job_id, namespace, edited_by, edited_at, title, body, priority, gate_required)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(id, current.namespace, agent.actor, now.toISOString(), current.title, current.body, current.priority, current.gate_required),
      // ?7 is the status read above, so the row is changed only in the state it was edited in.
      env.DB.prepare(
        `UPDATE jobs SET title = ?2, body = ?3, priority = ?4, gate_required = ?5, updated_at = ?6
         WHERE id = ?1 AND status = ?7 RETURNING id`
      ).bind(id, edited.title, edited.body, edited.priority, edited.gate_required, edited.updated_at, current.status),
      ...(await mirrorStatements(env, edited, "job-edited", agent.actor)),
      jobAudit(env.DB, agent.actor, "job-edited", edited, {
        changed,
        previous: { title: current.title, priority: current.priority, gate_required: current.gate_required },
        status: current.status,
      }),
    ]);
  } catch (err) {
    // The partial unique index over (namespace, title) for open jobs: another job took
    // the title between the check above and this write.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(message)) return collision(current.namespace, edited.title, await openTitleHolder(env.DB, current.namespace, edited.title, id).catch(() => null));
    throw err;
  }
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse(
      "edit",
      `${id} changed between reading it and editing it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}. Nothing was written.`
    );
  }
  return { ok: true, action: "edit", job: edited, versions: await jobVersions(env.DB, id) };
}
