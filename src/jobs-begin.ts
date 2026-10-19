import type { Env } from "./env";
import type { Agent } from "./agents";
import { outsideJobNamespace, startedNotice, type JobRow } from "./jobs-schema";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { guardedTransition, readJob, refuse, type JobResult } from "./jobs-transition";
import { verifySignedBody } from "./signed-docs";

// Begin: the started label (job_e68de044f8a4; Dustin, 2026-10-10, plan step 2). A cloud
// session works a job without claiming it and its pull request is the claim, as Copilot,
// Codex and Claude Code Projects do it. What it lacked was a way to tell the next
// session that somebody is already on the job. begin marks a queued job started:
// started_by and started_at (migrations/0042).
//
// A label, not a lease. It never expires, and nothing reads it to refuse anything:
// claim, complete and every other transition go on as before. The first session to
// begin a job keeps the label; a later begin is told who started it and when, and
// writes nothing. Any caller holding the write grant on the job's namespace may begin.
//
// begin is where a session that never claims starts acting on the body, so the body's
// signature is checked here as claim checks it: a body changed after post is refused,
// and the session is told not to run it. Nothing is written for it; claim is where a
// tampered job is marked failed.
//
// One guarded batch, like park: the label, the mirror and the audit row commit together
// or not at all, and the begin moves updated_at, so two sessions beginning at once
// resolve to one label and the second is told whose it is.

export async function beginJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  const current = await readJob(env.DB, id);
  if (!current) return refuse("begin", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside) return refuse("begin", `${agent.actor} cannot begin ${id} ('${current.title}'): ${outside}`);
  const already = startedNotice(current);
  if (already) return { ok: true, action: "begin", job: current, started: already, note: "already started; nothing was written." };
  if (current.status !== "queued") {
    return refuse(
      "begin",
      `${id} is ${current.status}${current.claimed_by ? ` (held by ${current.claimed_by})` : ""}. begin marks a queued job started; a claimed or blocked job already says who is on it, and a finished one is not reopened.`
    );
  }

  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, current.body, "job body");
  if (!verdict.ok) return refuse("begin", `${id} was not started, and its prompt must not be run: ${verdict.reason}`);

  const at = now.toISOString();
  const started: JobRow = { ...current, started_at: at, started_by: agent.actor, updated_at: at };
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET started_at = ?2, started_by = ?3, updated_at = ?2 WHERE id = ?1 AND status = 'queued' AND started_at IS NULL RETURNING id`
    ).bind(id, at, agent.actor),
    ...(await mirrorStatements(env, started, "job-started", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-started", started, { started_at: at }),
  ]);
  if (!won) {
    // Somebody began it, or it moved, between the read and the write. Never a refusal
    // when the reason is another session's label: say whose it is.
    const moved = await readJob(env.DB, id);
    const theirs = moved ? startedNotice(moved) : null;
    if (moved && theirs) return { ok: true, action: "begin", job: moved, started: theirs, note: "already started; nothing was written." };
    return refuse("begin", `${id} changed between reading it and beginning it: it is now ${moved?.status ?? "gone"}. Nothing was written.`);
  }
  return { ok: true, action: "begin", job: started, started: startedNotice(started) ?? undefined };
}
