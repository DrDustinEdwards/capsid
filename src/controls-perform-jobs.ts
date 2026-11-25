import {
  CLOSE_SHIPPED_NEEDS_REASON,
  SUPERSEDE_NEEDS_REASON,
  shippedEvidence,
} from "./controls-base";
import { type ActionResult, type PerformContext, required } from "./controls-perform-base";
import { parkJob, unparkJob } from "./jobs-park";
import { releaseJob, adminFailJob, completeAsCaller } from "./jobs-seat";
import { resumeJob } from "./jobs-seat-resume";
import { supersedeJob } from "./jobs-seat-supersede";
import { readJob } from "./jobs-transition";
import { runSiteJob } from "./site-jobs";

export async function performJobAction(
  c: PerformContext,
  action:
    | "resume_job"
    | "release_job"
    | "fail_job"
    | "close_shipped"
    | "supersede_job"
    | "park_job"
    | "unpark_job"
    | "run_job",
): Promise<ActionResult | null> {
  const { env, agent, actor, now, params, surface, state, auditClick, undo, click } = c;
  switch (action) {
    case "resume_job":
    case "release_job":
    case "fail_job": {
      const id = required(params, "id");
      const reason = required(params, "reason");
      if (!id) return { ok: false, refusal: `${action} needs a job id.` };
      if (!reason) {
        return {
          ok: false,
          refusal:
            action === "resume_job"
              ? "resume needs a reason: what you approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen."
              : action === "release_job"
                ? "release needs a reason: why the holder is not coming back."
                : "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.",
        };
      }
      // resume_job's note is the full approval when it is longer than a line (stale jobs D6): the driver
      // reads it as resume_note.note on its next claim or list.
      const note = action === "resume_job" ? (required(params, "note") ?? undefined) : undefined;
      const result =
        action === "resume_job"
          ? await resumeJob(env, agent, now, id, reason, { note })
          : action === "release_job"
            ? await releaseJob(env, agent, now, id, reason)
            : await adminFailJob(env, agent, now, id, reason);
      if (!result.ok) return { ok: false, refusal: result.refusal ?? `${action} was refused.` };
      state.committed = true;
      state.summary =
        action === "resume_job"
          ? result.job?.status === "queued"
            ? `Resumed ${id}; it went back to the queue. ${result.note ?? ""}`.trim()
            : `Resumed ${id}; it is claimed again by ${result.job?.claimed_by ?? "its claimant"}.`
          : action === "release_job"
            ? `Released ${id} back to the queue.`
            : `Marked ${id} failed.`;
      await auditClick(result.job?.namespace ?? null, {
        id,
        reason,
        ...(note ? { note } : {}),
      });
      return null;
    }
    case "close_shipped": {
      const id = required(params, "id");
      const reason = required(params, "reason");
      if (!id) return { ok: false, refusal: "close_shipped needs a job id." };
      if (!reason)
        return {
          ok: false,
          refusal: CLOSE_SHIPPED_NEEDS_REASON,
        };
      const job = await readJob(env.DB, id);
      if (!job) return { ok: false, refusal: `no job ${id}.` };
      const shipped = shippedEvidence(job);
      const result = await completeAsCaller(env, agent, now, id, {
        result_summary: `Closed as shipped by ${actor}: ${reason}`,
        ...(shipped.result_ref ? { result_ref: shipped.result_ref } : {}),
        ...(shipped.prs.length ? { evidence: { prs: shipped.prs } } : {}),
      });
      if (!result.ok) return { ok: false, refusal: result.refusal ?? "close_shipped was refused." };
      state.committed = true;
      state.summary = `Closed ${id} as shipped; the outcome is credited to ${job.claimed_by ?? "its holder"}.`;
      await auditClick(job.namespace, {
        id,
        reason,
        held_by: job.claimed_by,
        prs: shipped.prs.length,
      });
      return null;
    }
    case "supersede_job": {
      const id = required(params, "id");
      const reason = required(params, "reason");
      if (!id) return { ok: false, refusal: "supersede_job needs a job id." };
      if (!reason)
        return {
          ok: false,
          refusal: SUPERSEDE_NEEDS_REASON,
        };
      const replaced_by = required(params, "replaced_by") ?? undefined;
      const result = await supersedeJob(env, agent, now, id, { reason, replaced_by });
      if (!result.ok) return { ok: false, refusal: result.refusal ?? "supersede_job was refused." };
      state.committed = true;
      state.summary = `Superseded ${id}${replaced_by ? ` with ${replaced_by}` : ""}.`;
      await auditClick(result.job?.namespace ?? null, {
        id,
        reason,
        ...(replaced_by ? { replaced_by } : {}),
      });
      return null;
    }
    case "park_job":
    case "unpark_job": {
      const id = required(params, "id");
      if (!id) return { ok: false, refusal: `${action} needs a job id.` };
      const reason = required(params, "reason");
      if (action === "park_job" && !reason)
        return {
          ok: false,
          refusal: "park_job needs a reason in one line saying when the job comes back.",
        };
      const result =
        action === "park_job"
          ? await parkJob(env, agent, now, id, reason ?? undefined)
          : await unparkJob(env, agent, now, id);
      if (!result.ok) return { ok: false, refusal: result.refusal ?? `${action} was refused.` };
      state.committed = true;
      state.summary =
        action === "park_job" ? `Parked ${id}.` : `Unparked ${id}; it is queued again.`;
      await auditClick(
        result.job?.namespace ?? null,
        { id, reason, ...(undo ? { undo: true } : {}) },
        click,
      );
      return null;
    }
    case "run_job": {
      // Every check runs again inside runSiteJob: the configuration, token and rate limit can change
      // before the click.
      const namespace = required(params, "namespace");
      const name = required(params, "name");
      if (!namespace || !name)
        return { ok: false, refusal: "run_job needs a namespace and a job name." };
      const outcome = await runSiteJob(env, { namespace, name, actor, via: surface }, now);
      if (!outcome.ran) return { ok: false, refusal: outcome.refusal };
      state.committed = true;
      state.summary = `${namespace}: ${outcome.line}.${outcome.recorded ? "" : " The call's audit row was not written (SITE_JOB_NOT_RECORDED in the log)."}`;
      await auditClick(namespace, {
        job: name,
        ok: outcome.ok,
      });
      return null;
    }
  }
}
