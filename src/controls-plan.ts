import { adminAgentForEmail } from "./agents";
import {
  type Plan,
  type Surface,
  refused,
  AUTOMERGE_RESUME_REASON,
  UNIT_RESUME_REASON,
  clickAuditAction,
  shippedEvidence,
  switchReasonRefusal,
} from "./controls-base";
import { planRegistryAction } from "./controls-plan-registry";
import type { Env } from "./env";
import { breakerState } from "./job-breaker";
import { openTitleHolder } from "./jobs-edit";
import { resumeDestination, workRecorded } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { MAX_RESUME_NOTE } from "./limits";
import { planResume } from "./merge-safety";
import { planLift } from "./merge-units";
import type { PortalAction } from "./ops-types/portal";
import {
  overnightValueRefusal,
  overnightState,
  type OvernightMode,
  decisionFor,
  OVERNIGHT_MODE_KEY,
} from "./overnight";
import { planPolicyChange, planPolicyFromRepo } from "./policy-sign";
import { planApproval } from "./pr-approvals";
import { APP_ROSTER } from "./roster";

import { plural } from "@drdustinedwards/site-helpers/text";

// A control's preview (src/controls.ts is the core): reads the current state, writes
// nothing, and returns what will change and the audit rows it will write.

function rosterRefusal(action: "reset_breaker", namespace: string | undefined): string | null {
  if (!namespace) return `${action} needs a namespace.`;
  if (namespace === "all") {
    return `the Portal acts on one namespace at a time, so "all" is refused here. Do each of ${APP_ROSTER.join(", ")} in turn.`;
  }
  if (!(APP_ROSTER as readonly string[]).includes(namespace))
    return `'${namespace}' is not on the roster (${APP_ROSTER.join(", ")}).`;
  return null;
}

/** What the action will change, read from the state now. Reads only: no D1 write and
 *  no KV put, which test/portal-actions.test.ts asserts for every action. */
export async function planAction(
  env: Env,
  email: string,
  action: PortalAction,
  p: Record<string, string>,
  surface: Surface = "portal",
): Promise<Plan> {
  const actor = adminAgentForEmail(email).actor;
  const click = `${clickAuditAction(action, p, surface)} by ${actor}`;
  if (p.undo !== undefined && p.undo !== "true")
    return refused(`${action}'s undo is "true" or absent; got '${p.undo}'.`);
  switch (action) {
    case "reset_breaker": {
      const bad = rosterRefusal(action, p.namespace);
      if (bad) return refused(bad);
      const state = await breakerState(env, p.namespace, new Date());
      return {
        ok: true,
        changes: [
          state.open
            ? `The breaker for ${p.namespace} is OPEN: ${state.failed} holder fails since ${state.since} UTC, at or over the threshold of ${state.threshold}. After the reset only failures from now count, and ${p.namespace} hands out work again.`
            : `The breaker for ${p.namespace} is closed (${state.failed} of ${state.threshold} holder fails since ${state.since} UTC). The reset moves its window to now.`,
        ],
        audit: [`job-breaker-reset by ${actor}`, click],
      };
    }
    case "overnight": {
      const bad = overnightValueRefusal(p.value);
      if (bad) return refused(bad);
      if (!p.reason) return refused(switchReasonRefusal(action));
      const state = await overnightState(env);
      const value = p.value as OvernightMode;
      const decision = decisionFor(value, actor, new Date(), p.reason);
      return {
        ok: true,
        changes: [
          state.mode === value
            ? `${OVERNIGHT_MODE_KEY} is already ${value}; it is written again unchanged.`
            : `${OVERNIGHT_MODE_KEY}: ${state.mode} -> ${value}.`,
          ...(decision
            ? [
                `Recorded with the switch: the decision of ${decision.decided_by} on ${decision.decided_on}, "${decision.ruling}".`,
                `Reasoning recorded: ${decision.reasoning}`,
                "Hand-started VS Code tabs are unaffected and stay the default.",
              ]
            : value === "api"
              ? [
                  "The scheduler will refuse to start a run unless it authenticates with ANTHROPIC_API_KEY and no subscription token is in use.",
                ]
              : ["No scheduled run starts. Hand-started VS Code tabs are unaffected."]),
        ],
        audit: [`overnight-set by ${actor}`, click],
      };
    }
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
      if (!p.reason)
        return refused(
          "close_shipped needs a reason: what shipped, and how you know. It is the job's result summary.",
        );
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
      if (!p.reason)
        return refused(
          "supersede_job needs a reason: what replaced this job, or why it was withdrawn.",
        );
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
    case "approve_pr": {
      const plan = await planApproval(env, actor, p, surface, click);
      return plan.ok
        ? { ok: true, changes: plan.changes, audit: plan.audit }
        : refused(plan.refusal);
    }
    case "sign_policy_change": {
      const plan = await planPolicyChange(env, p.change, p.unit);
      return plan.ok
        ? { ok: true, changes: plan.changes, audit: [`policy-changed by ${actor}`, click] }
        : refused(plan.error);
    }
    case "sign_policy_from_repo": {
      const plan = await planPolicyFromRepo(env);
      // A typed version, when one comes with the preview, is checked now and bound into the token.
      if (plan.ok && p.confirm && p.confirm !== plan.to)
        return refused(
          `${p.confirm} is not the version in docs/policy/auto-merge.md, which says ${plan.to}. Type ${plan.to} to sign it. Nothing was signed.`,
        );
      return plan.ok
        ? {
            ok: true,
            changes: plan.changes,
            audit: [`policy-loaded-from-repo by ${actor}`, click],
            bind: { source_sha: plan.newSha },
          }
        : refused(plan.error);
    }
    case "unit_resume": {
      if (!p.reason) return refused(UNIT_RESUME_REASON);
      const plan = await planLift(env.APP_KV, p.unit);
      if (!plan.ok) return refused(plan.refusal);
      return {
        ok: true,
        changes: [
          `${plan.unit}: suspended since ${plan.suspension.since} ("${plan.suspension.reason}") -> lifted. The tick may merge its pull requests unattended again; a rollback after now suspends it again.`,
        ],
        audit: [`merge-unit-resumed by ${actor}`, click],
      };
    }
    case "automerge_resume": {
      if (!p.reason) return refused(AUTOMERGE_RESUME_REASON);
      const plan = await planResume(env.APP_KV, p.namespace);
      if (!plan.ok) return refused(plan.refusal);
      return {
        ok: true,
        changes: [
          `${plan.namespace}: auto-merge paused since ${plan.paused.since} ("${plan.paused.reason}") -> lifted. The tick may merge its pull requests unattended again; new bad merges pause it again.`,
        ],
        audit: [`auto-merge-resumed by ${actor}`, click],
      };
    }
    default:
      return planRegistryAction(env, action, p, actor, click);
  }
}
