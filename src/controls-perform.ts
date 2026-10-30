import { adminAgentForEmail } from "./agents";
import { revokeAgent } from "./agents-admin";
import { approveProposal, rejectProposal, readSweep } from "./canon";
import {
  type ActionParams,
  type Surface,
  AUTOMERGE_RESUME_REASON,
  CANON_REJECT_REASON,
  UNIT_RESUME_REASON,
  SWITCHES,
  auditPrefix,
  clickAuditAction,
  revisionOf,
  shippedEvidence,
  sweepOrder,
  switchReasonRefusal,
} from "./controls-base";
import type { Env } from "./env";
import { managePr } from "./github";
import { resetBreaker } from "./job-breaker";
import { parkJob, unparkJob } from "./jobs-park";
import { resumeJob, releaseJob, adminFailJob, completeAsCaller, supersedeJob } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { resumeNamespace } from "./merge-safety";
import { liftSuspension } from "./merge-units";
import { removePackage, validatePackage, addPackage, editPackage, describePackage } from "./ops-packages";
import { removeSite, validateSite, addSite, editSite, describeSite } from "./ops-sites";
import type { PortalAction } from "./ops-types/portal";
import { overnightValueRefusal, setOvernight } from "./overnight";
import { performPolicyChange, performPolicyFromRepo } from "./policy-sign";
import { planApproval, performApproval } from "./pr-approvals";
import { runSiteRepair } from "./site-repair";
import { auditStatement } from "./store-guards";

// A control's perform (src/controls.ts is the core): the one dispatch to the shared
// mutators, run once a signed preview token is verified.

function required(params: ActionParams, field: string): string | null {
  const value = params[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The click's own audit row, naming the admin and the address the click came from
// (sourceAddress). The shared mutators' rows do not always say who asked.
async function auditClick(
  env: Env,
  actor: string,
  source: string | null,
  surface: Surface,
  action: PortalAction,
  namespace: string | null,
  params: object,
  name = `${auditPrefix(surface)}${action}`
) {
  await env.DB.batch([auditStatement(env.DB, actor, name, namespace, null, { ...params, surface, source_address: source })]);
}

export type ActionResult =
  // It happened. warning is set when the click's own audit row was not written.
  | { ok: true; summary: string; warning: string | null }
  // It did not happen, and why.
  | { ok: false; refusal: string };

/** One action, performed by the administrator `email`: the shared mutator the MCP tool
 *  calls, then the click's audit row. Nothing here reimplements a transition. */
export async function performAction(
  env: Env,
  email: string,
  source: string | null,
  now: Date,
  action: PortalAction,
  params: ActionParams,
  surface: Surface = "portal"
): Promise<ActionResult> {
  const agent = adminAgentForEmail(email);
  const actor = agent.actor;
  // Set once the mutator succeeds, so the catch knows whether the action happened.
  let committed = false;
  let summary = "";
  // The switches: a reason in both directions, checked again here because the token
  // binds the params and a token signed before this rule could lack one. The reason and
  // whether this is an Undo go in the click row.
  const switchReason = SWITCHES.has(action) ? required(params, "reason") : null;
  if (SWITCHES.has(action) && !switchReason) return { ok: false, refusal: switchReasonRefusal(action) };
  const undo = params.undo === "true";
  const click = clickAuditAction(action, params, surface);
  const switchDetail = (result: object) => ({ ...result, reason: switchReason, ...(undo ? { undo: true } : {}) });
  try {
    switch (action) {
      case "reset_breaker": {
        const namespace = required(params, "namespace");
        if (!namespace) return { ok: false, refusal: "reset_breaker needs a namespace." };
        const result = await resetBreaker(env, actor, now, { namespace });
        if (!result.ok) return { ok: false, refusal: result.error };
        committed = true;
        summary = `Reset the circuit breaker for ${namespace}.`;
        await auditClick(env, actor, source, surface, action, namespace, result.state);
        break;
      }
      case "overnight": {
        const value = required(params, "value");
        const bad = overnightValueRefusal(value ?? undefined);
        if (bad) return { ok: false, refusal: bad };
        const result = await setOvernight(env, actor, now, { value: value ?? undefined, reason: switchReason ?? undefined });
        committed = true;
        summary = result.mode === "off" ? "Turned the overnight run off." : `Set the overnight run to run on ${result.mode === "api" ? "the API key" : "the subscription"}.`;
        await auditClick(env, actor, source, surface, action, null, switchDetail({ mode: result.mode, ...(result.decision ? { decision: result.decision } : {}) }), click);
        break;
      }
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
        // resume_job's note is the full approval when it is longer than a line (stale jobs
        // D6): the driver reads it as resume_note.note on its next claim or list.
        const note = action === "resume_job" ? (required(params, "note") ?? undefined) : undefined;
        const result =
          action === "resume_job"
            ? await resumeJob(env, agent, now, id, reason, { note })
            : action === "release_job"
              ? await releaseJob(env, agent, now, id, reason)
              : await adminFailJob(env, agent, now, id, reason);
        if (!result.ok) return { ok: false, refusal: result.refusal ?? `${action} was refused.` };
        committed = true;
        summary =
          action === "resume_job"
            ? result.job?.status === "queued"
              ? `Resumed ${id}; it went back to the queue. ${result.note ?? ""}`.trim()
              : `Resumed ${id}; it is claimed again by ${result.job?.claimed_by ?? "its claimant"}.`
            : action === "release_job"
              ? `Released ${id} back to the queue.`
              : `Marked ${id} failed.`;
        await auditClick(env, actor, source, surface, action, result.job?.namespace ?? null, { id, reason, ...(note ? { note } : {}) });
        break;
      }
      case "close_shipped": {
        const id = required(params, "id");
        const reason = required(params, "reason");
        if (!id) return { ok: false, refusal: "close_shipped needs a job id." };
        if (!reason) return { ok: false, refusal: "close_shipped needs a reason: what shipped, and how you know. It is the job's result summary." };
        const job = await readJob(env.DB, id);
        if (!job) return { ok: false, refusal: `no job ${id}.` };
        const shipped = shippedEvidence(job);
        const result = await completeAsCaller(env, agent, now, id, {
          result_summary: `Closed as shipped by ${actor}: ${reason}`,
          ...(shipped.result_ref ? { result_ref: shipped.result_ref } : {}),
          ...(shipped.prs.length ? { evidence: { prs: shipped.prs } } : {}),
        });
        if (!result.ok) return { ok: false, refusal: result.refusal ?? "close_shipped was refused." };
        committed = true;
        summary = `Closed ${id} as shipped; the outcome is credited to ${job.claimed_by ?? "its holder"}.`;
        await auditClick(env, actor, source, surface, action, job.namespace, { id, reason, held_by: job.claimed_by, prs: shipped.prs.length });
        break;
      }
      case "supersede_job": {
        const id = required(params, "id");
        const reason = required(params, "reason");
        if (!id) return { ok: false, refusal: "supersede_job needs a job id." };
        if (!reason) return { ok: false, refusal: "supersede_job needs a reason: what replaced this job, or why it was withdrawn." };
        const replaced_by = required(params, "replaced_by") ?? undefined;
        const result = await supersedeJob(env, agent, now, id, { reason, replaced_by });
        if (!result.ok) return { ok: false, refusal: result.refusal ?? "supersede_job was refused." };
        committed = true;
        summary = `Superseded ${id}${replaced_by ? ` with ${replaced_by}` : ""}.`;
        await auditClick(env, actor, source, surface, action, result.job?.namespace ?? null, { id, reason, ...(replaced_by ? { replaced_by } : {}) });
        break;
      }
      case "park_job":
      case "unpark_job": {
        const id = required(params, "id");
        if (!id) return { ok: false, refusal: `${action} needs a job id.` };
        const reason = required(params, "reason");
        if (action === "park_job" && !reason) return { ok: false, refusal: "park_job needs a reason in one line saying when the job comes back." };
        const result = action === "park_job" ? await parkJob(env, agent, now, id, reason ?? undefined) : await unparkJob(env, agent, now, id);
        if (!result.ok) return { ok: false, refusal: result.refusal ?? `${action} was refused.` };
        committed = true;
        summary = action === "park_job" ? `Parked ${id}.` : `Unparked ${id}; it is queued again.`;
        await auditClick(env, actor, source, surface, action, result.job?.namespace ?? null, { id, reason, ...(undo ? { undo: true } : {}) }, click);
        break;
      }
      case "approve_pr": {
        // Planned again from the state now: the heads, the classes and the open approvals
        // may have moved since the preview, and the approval is of what is true now.
        const clean = Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"));
        const plan = await planApproval(env, actor, clean, surface, click);
        if (!plan.ok) return { ok: false, refusal: plan.refusal };
        summary = await performApproval(env, actor, plan, required(params, "reason"), now);
        committed = true;
        await auditClick(env, actor, source, surface, action, plan.namespace, { repo: plan.repo, prs: plan.targets.map((t) => ({ pr: t.number, head_sha: t.head_sha, class: t.class })), approval_surface: plan.surface, ...(undo ? { undo: true } : {}) }, click);
        break;
      }
      case "sign_policy_change": {
        // Planned again from the policy now, and refused unless the new version is typed.
        const done = await performPolicyChange(env, actor, required(params, "change") ?? undefined, required(params, "unit") ?? undefined, required(params, "confirm") ?? undefined);
        if (!done.ok) return { ok: false, refusal: done.error };
        summary = done.summary;
        committed = true;
        await auditClick(env, actor, source, surface, action, "capsid", { change: params.change, unit: params.unit, confirm: params.confirm, reason: required(params, "reason") }, click);
        break;
      }
      case "sign_policy_from_repo": {
        // The file is read again and must read as the preview's did (the hash the token
        // binds), and the typed version must be the file's.
        const done = await performPolicyFromRepo(env, actor, required(params, "confirm") ?? undefined, required(params, "source_sha") ?? undefined);
        if (!done.ok) return { ok: false, refusal: done.error };
        summary = done.summary;
        committed = true;
        await auditClick(env, actor, source, surface, action, "capsid", { confirm: params.confirm, source_sha: params.source_sha, reason: required(params, "reason") }, click);
        break;
      }
      case "unit_resume": {
        const reason = required(params, "reason");
        if (!reason) return { ok: false, refusal: UNIT_RESUME_REASON };
        const done = await liftSuspension(env, actor, required(params, "unit") ?? undefined, reason, now);
        if (!done.ok) return { ok: false, refusal: done.refusal };
        summary = done.summary;
        committed = true;
        await auditClick(env, actor, source, surface, action, (params.unit ?? "").split("/")[0]!.trim() || null, { unit: params.unit, reason }, click);
        break;
      }
      case "automerge_resume": {
        const reason = required(params, "reason");
        if (!reason) return { ok: false, refusal: AUTOMERGE_RESUME_REASON };
        const done = await resumeNamespace(env, actor, required(params, "namespace") ?? undefined, reason, now);
        if (!done.ok) return { ok: false, refusal: done.refusal };
        summary = done.summary;
        committed = true;
        await auditClick(env, actor, source, surface, action, (params.namespace ?? "").trim() || null, { namespace: params.namespace, reason }, click);
        break;
      }
      case "pr_close": {
        const namespace = required(params, "namespace");
        const number = Number(required(params, "number"));
        const reason = required(params, "reason");
        if (!namespace || !Number.isInteger(number) || number < 1) return { ok: false, refusal: "pr_close needs a namespace and the pull request's number." };
        if (!reason) return { ok: false, refusal: "pr_close needs a reason: why the pull request is closed without merging." };
        const repo = required(params, "repo") ?? undefined;
        // Only the close shape comes back from action "close".
        const result = (await managePr(env, namespace, number, "close", "squash", repo)) as { repo: string; head_branch: string | null; head_branch_deleted: boolean };
        committed = true;
        summary = `Closed ${result.repo}#${number}${result.head_branch_deleted ? `; its branch ${result.head_branch} was deleted` : ""}.`;
        // managePr writes no audit row of its own (the guardedWrite behind capsid_close_pr action close does),
        // so the control writes the change's row beside the click row.
        await env.DB.batch([auditStatement(env.DB, actor, "pr-closed", namespace, null, { repo: result.repo, number, reason, head_branch: result.head_branch, head_branch_deleted: result.head_branch_deleted })]);
        await auditClick(env, actor, source, surface, action, namespace, { repo: result.repo, number, reason });
        break;
      }
      case "revoke_agent": {
        const name = required(params, "name");
        if (!name) return { ok: false, refusal: "revoke_agent needs an agent name." };
        const result = await revokeAgent(env.DB, actor, name);
        if (!result.ok) return { ok: false, refusal: result.refusal ?? `revoking ${name} was refused.` };
        committed = true;
        summary = `Revoked the agent ${name}.`;
        await auditClick(env, actor, source, surface, action, null, { name });
        break;
      }
      case "site_add":
      case "site_edit":
      case "site_remove": {
        // Checked again here, not only at preview: the token binds the params, and the
        // rules could have changed under a token signed before a deploy.
        let result;
        if (action === "site_remove") {
          const revision = revisionOf(params.revision);
          if (!params.namespace || revision === null) return { ok: false, refusal: "site_remove needs a namespace and the revision it previewed." };
          result = await removeSite(env.DB, actor, params.namespace, revision);
        } else {
          const checked = validateSite(params);
          if (!checked.ok) return { ok: false, refusal: checked.refusal };
          if (action === "site_add") {
            result = await addSite(env.DB, actor, checked.site);
          } else {
            const revision = revisionOf(params.revision);
            if (revision === null) return { ok: false, refusal: "site_edit needs the revision it previewed." };
            result = await editSite(env.DB, actor, checked.site, revision);
          }
        }
        if (!result.ok) return { ok: false, refusal: result.refusal };
        committed = true;
        summary =
          action === "site_add"
            ? `Added ${result.site.namespace}: ${describeSite(result.site)}.`
            : action === "site_edit"
              ? `Changed ${result.site.namespace}: ${describeSite(result.site)}.`
              : `Removed ${result.site.namespace} from the site configuration.`;
        await auditClick(env, actor, source, surface, action, result.site.namespace, params);
        break;
      }
      case "package_add":
      case "package_edit":
      case "package_remove": {
        // Checked again here, as the site controls are: the token binds the params, not
        // the rules they were checked against.
        let result;
        if (action === "package_remove") {
          const revision = revisionOf(params.revision);
          if (!params.name || revision === null) return { ok: false, refusal: "package_remove needs a name and the revision it previewed." };
          result = await removePackage(env.DB, actor, params.name, revision);
        } else {
          const checked = validatePackage(params);
          if (!checked.ok) return { ok: false, refusal: checked.refusal };
          if (action === "package_add") {
            result = await addPackage(env.DB, actor, checked.pkg);
          } else {
            const revision = revisionOf(params.revision);
            if (revision === null) return { ok: false, refusal: "package_edit needs the revision it previewed." };
            result = await editPackage(env.DB, actor, checked.pkg, revision);
          }
        }
        if (!result.ok) return { ok: false, refusal: result.refusal };
        committed = true;
        summary =
          action === "package_add"
            ? `Added ${describePackage(result.pkg)}.`
            : action === "package_edit"
              ? `Changed ${result.pkg.name}: ${describePackage(result.pkg)}.`
              : `Removed ${result.pkg.name} from the packages.`;
        await auditClick(env, actor, source, surface, action, null, params);
        break;
      }
      case "canon_approve":
      case "canon_reject": {
        // Checked again here, as the site controls are: the token binds the params, and
        // the proposal or its document can move between the preview and this click.
        const id = revisionOf(params.id);
        if (id === null) return { ok: false, refusal: `${action} needs the proposal id, a positive integer.` };
        const reason = required(params, "reason");
        if (action === "canon_reject" && !reason) return { ok: false, refusal: CANON_REJECT_REASON };
        const result = action === "canon_approve" ? await approveProposal(env.DB, actor, now, id) : await rejectProposal(env.DB, actor, now, id, reason as string);
        if (!result.ok) return { ok: false, refusal: result.refusal };
        committed = true;
        summary =
          action === "canon_approve"
            ? `Approved proposal ${id}: ${result.row.namespace}/${result.row.path} is written as ${result.row.proposer} proposed.`
            : `Rejected proposal ${id} for ${result.row.namespace}/${result.row.path}.`;
        await auditClick(env, actor, source, surface, action, result.row.namespace, { id, ...(reason ? { reason } : {}), path: result.row.path });
        break;
      }
      case "canon_approve_all": {
        // The token binds the plan its preview read. The queue is read again and the plan
        // must read the same, so a proposal that arrived, was decided or went stale since
        // is never swept in: the perform is refused and the preview shows the queue as it is.
        const bound = params.plan;
        if (!bound) return { ok: false, refusal: "canon_approve_all carries the plan its preview read, and this confirmation has none. Nothing changed. Preview again." };
        const sweep = await readSweep(env.DB);
        if (!sweep.ok) return { ok: false, refusal: `${sweep.refusal} The pending canon proposals changed since the preview. Nothing changed.` };
        if (sweep.key !== bound) {
          return { ok: false, refusal: `the pending canon proposals changed since the preview (it planned ${bound}; they now plan ${sweep.key}). Nothing changed. Preview again.` };
        }
        const reason = required(params, "reason");
        const done: Array<{ id: number; outcome: string; target: string }> = [];
        const failed: Array<{ id: number; outcome: string; target: string; refusal: string }> = [];
        for (const item of sweepOrder(sweep.items)) {
          const { id } = item.proposal;
          const target = `${item.proposal.namespace}/${item.proposal.path}`;
          // One failure does not stop the rest: each is its own decision, guarded on its
          // own state, and a failure is reported with its refusal.
          try {
            const result = item.reason === null ? await approveProposal(env.DB, actor, now, id) : await rejectProposal(env.DB, actor, now, id, item.reason);
            if (result.ok) done.push({ id, outcome: item.outcome, target });
            else failed.push({ id, outcome: item.outcome, target, refusal: result.refusal });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logEvent("CANON_APPROVE_ALL_ITEM_FAILED", { message, id, outcome: item.outcome }, { level: "error" });
            failed.push({ id, outcome: item.outcome, target, refusal: message });
          }
        }
        const failures = failed.map((f) => `${f.id} (${f.target}, to ${f.outcome === "approve" ? "approve" : "reject"}): ${f.refusal}`);
        if (!done.length) return { ok: false, refusal: `canon_approve_all decided nothing. ${failures.join(" ")}` };
        committed = true;
        const approved = done.filter((d) => d.outcome === "approve");
        const rejected = done.filter((d) => d.outcome !== "approve");
        summary = [
          `Decided ${done.length} of ${sweep.items.length} canon proposal(s).`,
          approved.length ? `Approved ${approved.map((d) => `${d.id} (${d.target})`).join(", ")}.` : "",
          rejected.length ? `Rejected ${rejected.map((d) => `${d.id} (${d.target}, ${d.outcome})`).join(", ")}.` : "",
          failed.length ? `Failed ${failed.length}: ${failures.join(" ")}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        await auditClick(env, actor, source, surface, action, null, {
          plan: bound,
          ...(reason ? { reason } : {}),
          approved: approved.map((d) => d.id),
          rejected: rejected.map((d) => d.id),
          failed: failed.map((f) => ({ id: f.id, refusal: f.refusal })),
        });
        break;
      }
      case "site_repair": {
        // Every check runs again inside runSiteRepair: the allowlist, the token and the
        // rate limit can all change between the preview and this click.
        const namespace = required(params, "namespace");
        const tool = required(params, "tool");
        if (!namespace || !tool) return { ok: false, refusal: "site_repair needs a namespace and a tool." };
        const outcome = await runSiteRepair(env, { namespace, tool, actor, auto: false, via: surface }, now);
        if (!outcome.ran) return { ok: false, refusal: outcome.refusal };
        committed = true;
        summary = `${namespace}: ${outcome.line}.${outcome.recorded ? "" : " The call's audit row was not written (SITE_REPAIR_NOT_RECORDED in the log)."}`;
        await auditClick(env, actor, source, surface, action, namespace, { tool, ok: outcome.call.ok, converged: outcome.call.converged });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (committed) {
      // The action happened; only the Portal's own audit row failed, so no refusal.
      const warning = `${action} completed, but the Portal audit row naming ${actor} was not written: ${message}`;
      logEvent("PORTAL_ACTION_AUDIT_FAILED", { message: warning }, { level: "error" });
      return { ok: true, summary, warning };
    }
    return { ok: false, refusal: message };
  }
  return { ok: true, summary, warning: null };
}
