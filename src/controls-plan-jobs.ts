import {
  CLOSE_SHIPPED_NEEDS_REASON,
  SUPERSEDE_NEEDS_REASON,
  shippedEvidence,
} from "./controls-base";
import { type Plan, refused } from "./controls-plan-base";
import type { Env } from "./env";
import { openTitleHolder } from "./jobs-edit";
import { resumeDestination } from "./jobs-seat-auto";
import { workRecorded } from "./jobs-seat-supersede";
import { readJob } from "./jobs-transition";
import { MAX_RESUME_NOTE } from "./limits";
import { readSiteRow } from "./ops-sites";
import { limitRefusalFor } from "./site-repair";
import { CAPSID_NAMESPACE, jobRefusal } from "./site-jobs";

import { plural } from "@drdustinedwards/site-helpers/text";

export async function planJobAction(
  env: Env,
  action:
    | "resume_job"
    | "release_job"
    | "fail_job"
    | "close_shipped"
    | "supersede_job"
    | "park_job"
    | "unpark_job"
    | "run_job",
  p: Record<string, string>,
  actor: string,
  click: string,
): Promise<Plan> {
  switch (action) {
    case "resume_job":
    case "release_job":
    case "fail_job": {
      if (!p.id) return refused(`${action} needs a job id.`);
      if (!p.reason)
        return refused(
          `${action} needs a reason. It is recorded in the audit row, and a transition with no reason is one nobody can review.`,
        );
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      const label = `${job.id} ('${job.title}' in ${job.namespace})`;
      if (action === "resume_job") {
        if (p.note && p.note.length > MAX_RESUME_NOTE) {
          return refused(
            `resume_job's note is at most ${MAX_RESUME_NOTE} characters, as for the capsid_work_jobs tool; this one is ${p.note.length}.`,
          );
        }
        if (job.status !== "blocked") {
          return refused(
            `${job.id} is ${job.status}, not blocked. Resume is how a job comes back off a gate; a queued job is claimed and a done or failed one is finished.`,
          );
        }
        const holder = job.claimed_by || actor;
        const { toQueue } = await resumeDestination(env, holder, job, false);
        return {
          ok: true,
          changes: [
            toQueue
              ? `${label}: blocked -> queued, claimed by nobody. The resume records why: ${toQueue}`
              : `${label}: blocked -> claimed by ${holder}. ${holder} continues it; it does not move to you.`,
            `resumed_count: ${job.resumed_count} -> ${job.resumed_count + 1}.`,
            `Your approval "${p.reason}" is recorded in the resume note the next holder reads${p.note ? `, with your note of ${plural(p.note.length, "character")} in full` : ""}.`,
          ],
          audit: [`job-resumed by ${actor}`, click],
        };
      }
      if (action === "release_job") {
        if (job.status !== "claimed") {
          return refused(
            `${job.id} is ${job.status}, not claimed. Release returns a claimed job to the queue; a blocked job is resumed, a queued one is already free, and a finished one is not reopened.`,
          );
        }
        return {
          ok: true,
          changes: [
            `${label}: claimed by ${job.claimed_by} -> queued, claimed by nobody.`,
            `${job.claimed_by}'s claim ends, and no outcome is recorded against ${job.claimed_by}.`,
          ],
          audit: [`job-released by ${actor}`, click],
        };
      }
      if (job.status !== "queued" && job.status !== "claimed" && job.status !== "blocked") {
        return refused(`${job.id} is already ${job.status}; there is nothing to fail.`);
      }
      return {
        ok: true,
        changes: [
          `${label}: ${job.status}${job.claimed_by ? ` (held by ${job.claimed_by})` : ""} -> failed, with the reason "${p.reason}".`,
          job.claimed_by
            ? `An outcome row records the failure against ${job.claimed_by}.`
            : `Nobody held it, so no outcome row is written.`,
        ],
        audit: [`job-admin-fail by ${actor}`, click],
      };
    }
    case "close_shipped": {
      if (!p.id) return refused("close_shipped needs a job id.");
      if (!p.reason) return refused(CLOSE_SHIPPED_NEEDS_REASON);
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      if (job.status !== "blocked") {
        return refused(
          `${job.id} is ${job.status}, not blocked. Close as shipped ends a blocked job whose work landed; a claimed job is completed by its holder, and a queued or finished one has nothing to close.`,
        );
      }
      if (job.claimed_by === actor) {
        return refused(
          `${job.id} is blocked and held by ${actor} itself. A holder resumes its own gate and completes the job; close as shipped is for a job another credential blocked.`,
        );
      }
      const shipped = shippedEvidence(job);
      return {
        ok: true,
        changes: [
          `${job.id} ('${job.title}' in ${job.namespace}): blocked -> done, with the result "Closed as shipped by ${actor}: ${p.reason}".`,
          `The outcome row credits ${job.claimed_by ?? "nobody"}, who did the work. No claim is recorded for you; one admin_complete touch records that you closed it.`,
          shipped.prs.length
            ? `The outcome verifies ${plural(shipped.prs.length, "pull request")} against GitHub: ${shipped.prs.join(", ")}${shipped.more ? ` (${shipped.more} more named, left out)` : ""}.`
            : "The job names no pull request, so the outcome verifies nothing.",
        ],
        audit: [`job-admin-complete by ${actor}`, click],
      };
    }
    case "supersede_job": {
      if (!p.id) return refused("supersede_job needs a job id.");
      if (!p.reason) return refused(SUPERSEDE_NEEDS_REASON);
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      const label = `${job.id} ('${job.title}' in ${job.namespace})`;
      if (job.status !== "queued" && job.status !== "claimed") {
        return refused(
          `${job.id} is ${job.status}. Supersede closes a queued job, or a claimed one with no work recorded; ${job.status === "blocked" ? "a blocked job has hit a gate, so it is failed instead" : "a finished job is not rewritten"}.`,
        );
      }
      const work = job.status === "claimed" ? workRecorded(job) : null;
      if (work)
        return refused(
          `${job.id} has work recorded on it: ${work}. Fail it instead; supersede is for a job replaced before any work was done.`,
        );
      if (p.replaced_by) {
        if (p.replaced_by === job.id) return refused(`${job.id} cannot be replaced by itself.`);
        const replacement = await readJob(env.DB, p.replaced_by);
        if (!replacement)
          return refused(
            `no job ${p.replaced_by}. replaced_by names the job that replaces this one, and it must exist.`,
          );
        if (replacement.namespace !== job.namespace)
          return refused(
            `${p.replaced_by} is in ${replacement.namespace} and ${job.id} is in ${job.namespace}. A job is replaced by work in its own namespace.`,
          );
      }
      return {
        ok: true,
        changes: [
          `${label}: ${job.status}${job.claimed_by ? ` (held by ${job.claimed_by})` : ""} -> superseded, with the summary "${p.replaced_by ? `Superseded by ${p.replaced_by}` : "Superseded"}: ${p.reason}".`,
          `No outcome row is written against anybody, and one supersede touch records that you did it.`,
        ],
        audit: [`job-superseded by ${actor}`, click],
      };
    }
    case "park_job": {
      if (!p.id) return refused("park_job needs a job id.");
      if (!p.reason || p.reason.length > 300 || /[\r\n]/.test(p.reason)) {
        return refused(
          'park_job needs a reason in one line, at most 300 characters, saying when the job comes back ("comes back when ...").',
        );
      }
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      if (job.status !== "queued") {
        return refused(
          `${job.id} is ${job.status}. Park changes a queued job; a claimed or blocked one has somebody on it, so resume or supersede that instead.`,
        );
      }
      return {
        ok: true,
        changes: [
          `${job.id} ('${job.title}' in ${job.namespace}): queued -> parked, with "${p.reason}". It is never claimed and never planned while parked.`,
          "It keeps its row, its priority and its mirror document, and Unpark puts it back in the queue.",
        ],
        audit: [`job-parked by ${actor}`, click],
      };
    }
    case "unpark_job": {
      if (!p.id) return refused("unpark_job needs a job id.");
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      if (job.status !== "parked") return refused(`${job.id} is ${job.status}, not parked.`);
      const holder = await openTitleHolder(env.DB, job.namespace, job.title, job.id);
      if (holder) {
        return refused(
          `${job.namespace} already has another open job titled '${job.title}': ${holder.id} is ${holder.status}. One open job per (namespace, title), so ${job.id} stays parked.`,
        );
      }
      return {
        ok: true,
        changes: [
          `${job.id} ('${job.title}' in ${job.namespace}): parked ("${job.result_summary ?? ""}") -> queued, at priority ${job.priority}. The next free session may claim it.`,
        ],
        audit: [`job-unparked by ${actor}`, click],
      };
    }
    case "run_job": {
      if (!p.namespace || !p.name) return refused("run_job needs a namespace and a job name.");
      const bad = await jobRefusal(env, p.namespace, p.name);
      if (bad) return refused(bad);
      if (p.namespace === CAPSID_NAMESPACE)
        return {
          ok: true,
          changes: [
            `capsid: run Capsid's own ${p.name} job now, the same run as the nightly 09:00 UTC cron, with its task_runs row (${p.name}). The dump takes the cron's lease, so a run that overlaps the cron skips.`,
          ],
          audit: [`site-job by ${actor}`, click],
        };
      const row = await readSiteRow(env.DB, p.namespace);
      const wait = await limitRefusalFor(env, p.namespace, `run_job:${p.name}`, new Date());
      if (wait) return refused(`${p.name} on ${p.namespace} waits: ${wait}`);
      return {
        ok: true,
        changes: [
          `POST ${row?.origin ?? ""}${row?.operator?.path ?? ""} with tool run_job { job: "${p.name}" }, authorized by the Capsid Worker secret ${row?.operator?.auth_var ?? ""} (the token is never shown or recorded).`,
          "The site runs that job now through the code its cron runs (site-runtime runJobTool), recorded in its cron_runs so /health's cron check sees the run, and answers each run's outcome; the result is shown when it returns, up to five minutes. A name the site does not run is refused by the site, naming its jobs. One audit_log and one task_runs row (site-job) record it.",
        ],
        audit: [`site-job by ${actor}`, click],
      };
    }
  }
}
