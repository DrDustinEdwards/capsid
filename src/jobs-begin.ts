import type { Env } from "./env";
import type { Agent } from "./agents";
import { outsideJobNamespace, startedNotice, type JobRow } from "./jobs-schema";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { guardedTransition, readJob, refuse, type JobResult } from "./jobs-transition";
import { verifySignedBody } from "./signed-docs";

// One guarded batch, like park: the label, mirror and audit row commit together, and the begin
// moves updated_at, so two sessions beginning at once resolve to one label.

export async function beginJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  const current = await readJob(env.DB, id);
  if (!current) return refuse("begin", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse("begin", `${agent.actor} cannot begin ${id} ('${current.title}'): ${outside}`);
  const already = startedNotice(current);
  if (already)
    return {
      ok: true,
      action: "begin",
      job: current,
      started: already,
      note: "already started; nothing was written.",
    };
  if (current.status !== "queued") {
    return refuse(
      "begin",
      `${id} is ${current.status}${current.claimed_by ? ` (held by ${current.claimed_by})` : ""}. begin marks a queued job started; a claimed or blocked job already says who is on it, and a finished one is not reopened.`,
    );
  }

  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, current.body, "job body");
  if (!verdict.ok)
    return refuse(
      "begin",
      `${id} was not started, and its prompt must not be run: ${verdict.reason}`,
    );

  const at = now.toISOString();
  const started: JobRow = { ...current, started_at: at, started_by: agent.actor, updated_at: at };
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET started_at = ?2, started_by = ?3, updated_at = ?2 WHERE id = ?1 AND status = 'queued' AND started_at IS NULL RETURNING id`,
    ).bind(id, at, agent.actor),
    ...(await mirrorStatements(env, started, "job-started", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-started", started, { started_at: at }),
  ]);
  if (!won) {
    // Somebody began it, or it moved, between the read and the write. Never a refusal when the reason
    // is another session's label: say whose it is.
    const moved = await readJob(env.DB, id);
    const theirs = moved ? startedNotice(moved) : null;
    if (moved && theirs)
      return {
        ok: true,
        action: "begin",
        job: moved,
        started: theirs,
        note: "already started; nothing was written.",
      };
    return refuse(
      "begin",
      `${id} changed between reading it and beginning it: it is now ${moved?.status ?? "gone"}. Nothing was written.`,
    );
  }
  return { ok: true, action: "begin", job: started, started: startedNotice(started) ?? undefined };
}
