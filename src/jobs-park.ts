import type { Env } from "./env";
import type { Agent } from "./agents";
import { outsideJobNamespace, type JobRow } from "./jobs-schema";
import { openTitleHolder } from "./jobs-edit";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { callerIsSeat, guardedTransition, readJob, refuse, type JobResult } from "./jobs-transition";

// Park: a job that is wanted but not now (job_4ef99d687805, Dustin 2026-10-07), for
// example one kept on his request until a decision comes back. A parked job is never
// claimed (claim reads only queued rows), never planned (the overnight plan reads only
// queued rows), and still listed and searchable: it keeps its row and its mirror.
//
// The seat's act, like edit: the admin or a can_merge caller, never a driver. A driver
// that could park a job could take work out of the queue's order. Only a queued job is
// parked. A claimed job is being worked, and a blocked one has somebody waiting on it:
// resume or supersede those. The one-line reason ("comes back when ...") is kept in
// result_summary, the column a blocked job already uses for why it is not moving, so
// there is no migration, and it is cleared when the job comes back.
//
// Parked is not an open status (src/jobs-schema.ts): it holds no title slot, so the
// partial unique index is unchanged and the feed, namespace delete and the watcher read
// a parked job as they read a finished one. The price is that the same title can be
// posted while a job is parked, so unpark refuses, naming the job, when it would put a
// second open job under one title.

const REASON_MAX = 300;

/** A reason is one line: it is shown in a list, not read as a document. */
function oneLine(reason: string | undefined): string | null {
  const text = (reason ?? "").trim();
  if (!text || text.length > REASON_MAX || /[\r\n]/.test(text)) return null;
  return text;
}

export async function parkJob(env: Env, agent: Agent, now: Date, id: string, reason: string | undefined): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse("park", `${agent.actor} cannot park a job. Parking is the seat's act, and this caller holds neither the admin identity nor can_merge.`);
  }
  const why = oneLine(reason);
  if (!why) {
    return refuse("park", `park needs a reason in one line, at most ${REASON_MAX} characters, saying when the job comes back ("comes back when ...").`);
  }
  const current = await readJob(env.DB, id);
  if (!current) return refuse("park", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("park", `${agent.actor} cannot park ${id} ('${current.title}'): ${outside}`);
  if (current.status !== "queued") {
    return refuse(
      "park",
      `${id} is ${current.status}${current.claimed_by && current.status === "claimed" ? ` (held by ${current.claimed_by})` : ""}. Park changes a queued job; a claimed or blocked one has somebody on it, so resume or supersede that instead.`
    );
  }

  const parked: JobRow = { ...current, status: "parked", result_summary: why, updated_at: now.toISOString() };
  const won = await guardedTransition(env, current, [
    env.DB.prepare(`UPDATE jobs SET status = 'parked', result_summary = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'queued' RETURNING id`).bind(
      id,
      why,
      parked.updated_at
    ),
    ...(await mirrorStatements(env, parked, "job-parked", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-parked", parked, { reason: why, priority: current.priority }),
  ]);
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse("park", `${id} changed between reading it and parking it: it is now ${moved?.status ?? "gone"}. Nothing was written.`);
  }
  return { ok: true, action: "park", job: parked };
}

export async function unparkJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  if (!callerIsSeat(agent)) {
    return refuse("unpark", `${agent.actor} cannot unpark a job. Unparking is the seat's act, and this caller holds neither the admin identity nor can_merge.`);
  }
  const current = await readJob(env.DB, id);
  if (!current) return refuse("unpark", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("unpark", `${agent.actor} cannot unpark ${id} ('${current.title}'): ${outside}`);
  if (current.status !== "parked") return refuse("unpark", `${id} is ${current.status}, not parked.`);

  const holder = await openTitleHolder(env.DB, current.namespace, current.title, id);
  if (holder) {
    return refuse(
      "unpark",
      `${current.namespace} already has another open job titled '${current.title}': ${holder.id} is ${holder.status}. One open job per (namespace, title), so ${id} stays parked and nothing was written.`
    );
  }

  const queued: JobRow = { ...current, status: "queued", result_summary: null, updated_at: now.toISOString() };
  let won: boolean;
  try {
    won = await guardedTransition(env, current, [
      env.DB.prepare(`UPDATE jobs SET status = 'queued', result_summary = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'parked' RETURNING id`).bind(
        id,
        queued.updated_at
      ),
      ...(await mirrorStatements(env, queued, "job-unparked", agent.actor)),
      jobAudit(env.DB, agent.actor, "job-unparked", queued, { was: current.result_summary }),
    ]);
  } catch (err) {
    // The partial unique index: another job took the title between the check and the write.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(message)) {
      const taken = await openTitleHolder(env.DB, current.namespace, current.title, id).catch(() => null);
      return refuse("unpark", `${current.namespace} took the title '${current.title}'${taken ? ` (${taken.id} is ${taken.status})` : ""} while this was being read. ${id} stays parked and nothing was written.`);
    }
    throw err;
  }
  if (!won) {
    const moved = await readJob(env.DB, id);
    return refuse("unpark", `${id} changed between reading it and unparking it: it is now ${moved?.status ?? "gone"}. Nothing was written.`);
  }
  return { ok: true, action: "unpark", job: queued };
}
