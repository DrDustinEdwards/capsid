import type { Env } from "./env";
import type { Agent } from "./agents";
import {
  outsideJobNamespace,
  swallowedParamTag,
  swallowedTagRefusal,
  type JobRow,
} from "./jobs-schema";
import { jobAudit, mirrorStatements } from "./jobs-mirror";
import { actorKind, touchStatement } from "./job-touches";
import {
  callerIsSeat,
  guardedTransition,
  readJob,
  refuse,
  type JobResult,
} from "./jobs-transition";
import { plural } from "@drdustinedwards/site-helpers/text";

// Supersede: the seat replacing a job before any work was done on it (a corrected or reposted
// body, a reorder, a withdrawal). Without it the only way to close such a job is to claim and fail
// it, filling the history with failures that never happened. No outcome row, no pull request rows.

export function workRecorded(job: JobRow): string | null {
  const done: string[] = [];
  if (job.blocked_count > 0) done.push(`it has hit a gate ${plural(job.blocked_count, "time")}`);
  if (job.resumed_count > 0) done.push(`it has been resumed ${plural(job.resumed_count, "time")}`);
  if (job.corrections_count > 0)
    done.push(`it has been sent back for correction ${plural(job.corrections_count, "time")}`);
  if (job.result_ref) done.push(`it records a result_ref (${job.result_ref})`);
  return done.length ? done.join(", ") : null;
}

// `extra` rides in the same guarded batch, so a caller's own write commits only with the supersede
// (the bench score step, src/bench-score.ts finishBenchRun).
export async function supersedeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { reason: string; replaced_by?: string },
  extra: D1PreparedStatement[] = [],
): Promise<JobResult> {
  const reason = args.reason?.trim();
  if (!reason) {
    return refuse(
      "supersede",
      "supersede needs a reason: what replaced this job, or why it was withdrawn.",
    );
  }
  const swallowed = swallowedParamTag(args.reason);
  if (swallowed) return refuse("supersede", swallowedTagRefusal("reason", swallowed));

  const current = await readJob(env.DB, id);
  if (!current) return refuse("supersede", `no job ${id}.`);
  const outside = outsideJobNamespace(agent, current.namespace);
  if (outside)
    return refuse(
      "supersede",
      `${agent.actor} cannot supersede ${id} ('${current.title}'): ${outside}`,
    );

  const replacedBy = args.replaced_by?.trim() || null;
  if (replacedBy) {
    if (replacedBy === id) return refuse("supersede", `${id} cannot be replaced by itself.`);
    const replacement = await env.DB.prepare("SELECT id, namespace FROM jobs WHERE id = ?1")
      .bind(replacedBy)
      .first<{ id: string; namespace: string }>();
    if (!replacement)
      return refuse(
        "supersede",
        `no job ${replacedBy}. replaced_by names the job that replaces this one, and it must exist.`,
      );
    if (replacement.namespace !== current.namespace) {
      return refuse(
        "supersede",
        `${replacedBy} is in ${replacement.namespace} and ${id} is in ${current.namespace}. A job is replaced by work in its own namespace.`,
      );
    }
  }

  if (current.status !== "queued" && current.status !== "claimed") {
    return refuse(
      "supersede",
      `${id} is ${current.status}. Supersede closes a queued job, or a claimed one with no work recorded; ${current.status === "blocked" ? "a blocked job has hit a gate, so it is failed instead" : "a finished job is not rewritten"}.`,
    );
  }
  if (current.status === "claimed") {
    const isSeat = callerIsSeat(agent);
    if (current.claimed_by !== agent.actor && !isSeat) {
      return refuse(
        "supersede",
        `${id} is held by ${current.claimed_by}, not by ${agent.actor}. Superseding a job somebody else holds is the seat's act, and this caller holds neither the admin identity nor can_merge.`,
      );
    }
    const work = workRecorded(current);
    if (work)
      return refuse(
        "supersede",
        `${id} has work recorded on it: ${work}. Fail it instead; supersede is for a job replaced before any work was done.`,
      );
  }

  const summary = replacedBy ? `Superseded by ${replacedBy}: ${reason}` : `Superseded: ${reason}`;
  // ?4 is the holder read above, so a claim that went to another driver between the read and this
  // write is not superseded out from under the new one.
  const job: JobRow = {
    ...current,
    status: "superseded",
    result_summary: summary,
    updated_at: now.toISOString(),
  };
  // The guard makes the mirror and audit row commit only with the UPDATE: a row that changed since
  // the read (a gate hit, a claim) aborts all three.
  const won = await guardedTransition(env, current, [
    env.DB.prepare(
      `UPDATE jobs SET status = 'superseded', result_summary = ?2, summary_sig = NULL, updated_at = ?3
       WHERE id = ?1 AND (status = 'queued' OR (status = 'claimed' AND claimed_by = ?4 AND blocked_count = 0
         AND resumed_count = 0 AND corrections_count = 0 AND result_ref IS NULL)) RETURNING id`,
    ).bind(id, summary, now.toISOString(), current.claimed_by),
    ...(await mirrorStatements(env, job, "job-superseded", agent.actor)),
    jobAudit(env.DB, agent.actor, "job-superseded", job, {
      reason,
      replaced_by: replacedBy,
      from: current.status,
      held_by: current.claimed_by,
    }),
    touchStatement(env.DB, {
      job_id: id,
      namespace: job.namespace,
      kind: "supersede",
      actor: agent.actor,
      actor_kind: actorKind(agent.actor, { seat: callerIsSeat(agent) }),
      detail: {
        reason,
        replaced_by: replacedBy,
        from: current.status,
        held_by: current.claimed_by,
      },
      sinceGate: false, // only a queued or claimed job is superseded, so no gate is open
      at: now.toISOString(),
    }),
    ...extra,
  ]);
  if (!won) {
    const moved = await readJob(env.DB, id);
    const work = moved ? workRecorded(moved) : null;
    return refuse(
      "supersede",
      `${id} changed between reading it and superseding it: it is now ${moved?.status ?? "gone"}${moved?.claimed_by ? `, held by ${moved.claimed_by}` : ""}${work ? `, and ${work}` : ""}. Nothing was written.`,
    );
  }
  return { ok: true, action: "supersede", job };
}
