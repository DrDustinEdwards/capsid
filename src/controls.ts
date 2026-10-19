import { archivedAgentByName } from "./agents-archive";
import { adminAgentForEmail } from "./agents";
import { revokeAgent } from "./agents-admin";
import { agentActor } from "./agents-schema";
import { hmacHex, timingSafeEqual } from "./auth";
import { sourceAddress } from "./portal-auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { breakerState, resetBreaker } from "./job-breaker";
import { addPackage, describePackage, editPackage, readPackageRow, removePackage, validatePackage } from "./ops-packages";
import { APP_ROSTER } from "./roster";
import { adminFailJob, completeAsCaller, releaseJob, resumeJob } from "./jobs";
import { parkJob, unparkJob } from "./jobs-park";
import { MAX_RESUME_NOTE } from "./limits";
import { resumeDestination, supersedeJob, workRecorded } from "./jobs-seat";
import { openTitleHolder } from "./jobs-edit";
import { resolveRepo } from "./github/client";
import { managePr } from "./github/refs";
import { performApproval, planApproval } from "./pr-approvals";
import { performPolicyChange, performPolicyFromRepo, planPolicyChange, planPolicyFromRepo } from "./policy-sign";
import { liftSuspension, planLift } from "./merge-units";
import { planResume, resumeNamespace } from "./merge-safety";
import type { JobRow } from "./jobs-schema";
import { readJob } from "./jobs-transition";
import { prUrlsFromJob } from "./outcome-prs";
import { addSite, describeSite, editSite, readSiteRow, removeSite, validateSite, type SiteInput } from "./ops-sites";
import type { PortalAction, PortalPreview } from "./ops-types";
import { decisionFor, OVERNIGHT_MODE_KEY, overnightState, overnightValueRefusal, setOvernight, type OvernightMode } from "./overnight";
import { auditStatement } from "./store-guards";
import { approveProposal, checkProposal, lineChanges, readSweep, rejectProposal, type SweepItem } from "./canon";
import { logEvent } from "./log";
import { limitRefusalFor, runSiteRepair } from "./site-repair";
import { tokenSet, toolRefusal } from "./site-operator";

// THE CONTROLS' CORE (capsid/research/design-portal-full-controls.md, section 2): what each
// admin control is, what it will do, the one dispatch to the shared mutators, and the
// signed confirmation both surfaces use. It was the body of src/portal-actions.ts; the
// Portal's routes there and the `capsid_admin_run_controls` tool (src/tools/controls.ts) are its two
// callers, so a control is implemented once and parity is a property of this file.

export const TOKEN_TTL_SECONDS = 5 * 60;
// Its own context string, so this key differs from every other key derived from
// COOKIE_ENCRYPTION_KEY, and a version bump retires every outstanding token.
const TOKEN_CONTEXT = "capsid-portal-confirm:v2";

export const PORTAL_ACTIONS: readonly PortalAction[] = [
  "overnight",
  "resume_job",
  "fail_job",
  "release_job",
  "close_shipped",
  "supersede_job",
  "park_job",
  "unpark_job",
  "pr_close",
  "approve_pr",
  "revoke_agent",
  "site_add",
  "site_edit",
  "site_remove",
  "reset_breaker",
  "package_add",
  "package_edit",
  "package_remove",
  "canon_approve",
  "canon_reject",
  "canon_approve_all",
  "site_repair",
  "sign_policy_change",
  "sign_policy_from_repo",
  "unit_resume",
  "automerge_resume",
];

export type ActionParams = Record<string, string | undefined>;

// The click's own audit row is `<prefix><action>`. Rows written before the move to
// /portal say console-<action>; a query across that date names both (docs/schema.md).
const CLICK_AUDIT_PREFIX = "portal-";

// The automation switch (overnight) takes a reason in both directions, and an Undo
// from the Portal's result message sends the reverse change with undo: "true". Its click row is then `portal-undo-<action>`, so an undo reads as its
// own row, never as a fresh decision (ruled 2026-09-30, DECIDE 5).
const SWITCHES: ReadonlySet<PortalAction> = new Set<PortalAction>(["overnight"]);
const UNDO_INFIX = "undo-";

// Which front door an action came in by. A click in the Portal and a call to the
// controls tool are the same control; the audit row says which (controls design,
// section 2): portal-<action> from the Portal as it always was, control-<action>
// from chat.
export type Surface = "portal" | "chat";
const CHAT_AUDIT_PREFIX = "control-";
const auditPrefix = (surface: Surface) => (surface === "portal" ? CLICK_AUDIT_PREFIX : CHAT_AUDIT_PREFIX);

/** The click row's action name: portal-<action>, or portal-undo-<action> for an Undo
 *  (control- for chat). */
function clickAuditAction(action: PortalAction, params: ActionParams, surface: Surface = "portal"): string {
  return `${auditPrefix(surface)}${params.undo === "true" ? UNDO_INFIX : ""}${action}`;
}

/** What a switch without a reason is told, at preview and again at perform. */
function switchReasonRefusal(action: PortalAction): string {
  switch (action) {
    case "overnight":
      return "overnight needs a reason: why the overnight run goes on, off, or changes what it runs on. It is recorded in the audit row with the change.";
    default:
      return `${action} needs a reason, recorded in the audit row with the change.`;
  }
}

/** What each action is about to do, naming the target, for the confirm step. */
function describeAction(action: PortalAction, params: ActionParams): string {
  const said = describeOnce(action, params);
  return params.undo === "true" ? `Undo: ${said}` : said;
}

function describeOnce(action: PortalAction, params: ActionParams): string {
  const ns = params.namespace ?? "";
  const id = params.id ?? "";
  switch (action) {
    case "overnight":
      return params.value === "off"
        ? "Turn the overnight run OFF. No scheduled run starts; one already running finishes."
        : params.value === "subscription"
          ? "Set the overnight run to run on the SUBSCRIPTION. The scheduler may then start the per-namespace drivers on your machine overnight, billed against your Max plan. This records your decision, its date and its reasoning where the switch is set."
          : "Set the overnight run to run on the API key. The scheduler refuses to start unless it authenticates with ANTHROPIC_API_KEY and no subscription token is in use. Billed per token to your Console account.";
    case "resume_job":
      return `Resume blocked job ${id}. The job moves back to claimed under the driver that blocked it, and that driver continues it. It does not move to you. If the job was blocked by a shared identity such as your own admin session, it goes back to the queue with your approval instead, and the next free session claims it.`;
    case "release_job":
      return `Release job ${id} back to the queue. Whoever holds it loses the claim, the next free session claims it, and no outcome is recorded against the holder.`;
    case "fail_job":
      return `Mark job ${id} failed. This is the seat stepping in on a job it does not hold, and it is recorded as such.`;
    case "close_shipped":
      return `Close blocked job ${id} as shipped. Its work landed, so the job moves to done, and the outcome is credited to the driver that did the work, not to you. The pull requests it names are read from GitHub for the outcome, and the close is recorded as yours.`;
    case "supersede_job":
      return `Supersede job ${id}${params.replaced_by ? ` with ${params.replaced_by}` : ""}. It ends as superseded, replaced before any work was done: no outcome row is written against anybody.`;
    case "park_job":
      return `Park job ${id}. It stays listed but is never claimed or planned until somebody unparks it; the reason says when it comes back.`;
    case "unpark_job":
      return `Unpark job ${id}. It goes back to the queue at its priority, and the next free session may claim it.`;
    case "pr_close":
      return `Close pull request #${params.number ?? ""} in ${ns}${params.repo ? ` (${params.repo})` : ""} without merging it. Its head branch is deleted as capsid_close_pr action close deletes it. GitHub can reopen it; the Portal does not.`;
    case "approve_pr":
      return params.undo === "true"
        ? `Void the open approval of pull request ${params.prs ?? ""} in ${ns}. The executor will not merge it.`
        : `Approve pull request ${params.prs ?? ""} in ${ns} at the head you reviewed. Nothing merges now: the executor merges an approved pull request once CI is green on that exact sha, and a new push, red CI or 7 days voids the approval.`;
    case "revoke_agent":
      return `Revoke the agent ${params.name ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
    case "site_add":
      return params.origin
        ? `Add ${ns} to the sites Capsid Portal watches. The watcher probes it from its next pass.`
        : `Record that ${ns} serves no site, so the site-map check stops reporting it as unmapped.`;
    case "site_edit":
      return `Change how Capsid Portal watches ${ns}. The watcher reads the new row on its next pass.`;
    case "site_remove":
      return `Remove ${ns} from the Portal's site configuration. The watcher stops probing it on its next pass.`;
    case "reset_breaker":
      return `Reset the queue's circuit breaker for ${ns}. Jobs its drivers failed before now stop counting, so ${ns} hands out work again until the threshold is reached anew.`;
    case "package_add":
      return `Add the npm package ${params.name ?? ""} to the packages Capsid Portal watches. The watcher reads it from its next pass.`;
    case "package_edit":
      return `Change how Capsid Portal watches the package ${params.name ?? ""}. The watcher reads the new row on its next pass.`;
    case "package_remove":
      return `Remove the package ${params.name ?? ""} from the Portal. The watcher stops reading it; its weekly rows are kept.`;
    case "canon_approve":
      return `Approve canon proposal ${params.id ?? ""}. The document is written as proposed, with the current version snapshotted first, and only if it is still the body the proposal was written against.`;
    case "canon_reject":
      return `Reject canon proposal ${params.id ?? ""}. The document is not touched, and the proposer reads your reason.`;
    case "canon_approve_all":
      return "Decide every pending canon proposal at once. On each document the newest proposal is approved, written as the single Approve writes it, unless its document moved since it was written; older proposals on the same document, and outdated ones, are rejected with a reason the proposer reads.";
    case "site_repair":
      return `Run ${params.tool ?? ""} on ${ns} through its operator API. It re-derives one of the site's stores from its source and reports whether it converged. Capsid calls only the site's allowlisted repairs; it never merges and never mints.`;
    case "sign_policy_change":
      return params.change === "demote"
        ? `Write and sign the next version of the auto-merge policy without the merge unit ${params.unit ?? ""}: its pull requests wait for an approval again.`
        : `Write and sign the next version of the auto-merge policy with the merge unit ${params.unit ?? ""} promoted to auto: its pull requests may merge with no human when every other check passes. This widens autonomy, so the new version number is typed as confirm.`;
    case "sign_policy_from_repo":
      return "Write the auto-merge policy from docs/policy/auto-merge.md on the default branch, exactly as it reads there, and sign it. The version in the file is typed as confirm, because the policy decides what merges with no human.";
    case "unit_resume":
      return `Lift the suspension of the merge unit ${params.unit ?? ""}. The tick may merge its pull requests unattended again, and the rollbacks before now suspend it no more.`;
    case "automerge_resume":
      return `Lift the pause on auto-merge for ${ns}. The tick may merge its pull requests unattended again, and the rollbacks and reverts before now count against it no more.`;
  }
}

function required(params: ActionParams, field: string): string | null {
  const value = params[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// close_shipped's complete (stale jobs D4, ruled 2026-10-09: the existing admin_complete
// path, crediting the holder). The pull requests the job names, from result_ref and the
// summary, become the evidence the outcome verifies, at most the 10 the capsid_work_jobs tool takes.
const CLOSE_SHIPPED_MAX_PRS = 10;
function shippedEvidence(job: JobRow): { result_ref?: string; prs: string[]; more: number } {
  const all = prUrlsFromJob(job);
  const prs = all.slice(0, CLOSE_SHIPPED_MAX_PRS);
  const ref = job.result_ref && prs.includes(job.result_ref) ? job.result_ref : prs[0];
  return { ...(ref ? { result_ref: ref } : {}), prs, more: all.length - prs.length };
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
async function performAction(
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
            logEvent("error", "CANON_APPROVE_ALL_ITEM_FAILED", { id, outcome: item.outcome, message });
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
      logEvent("error", "PORTAL_ACTION_AUDIT_FAILED", { message: warning });
      return { ok: true, summary, warning };
    }
    return { ok: false, refusal: message };
  }
  return { ok: true, summary, warning: null };
}


const UNKNOWN_ACTION = (action: string) =>
  `unknown Portal action '${action}'. The Portal does: ${PORTAL_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them: a merge can start a deploy and stays behind can_merge, and a mint hands out a key.`;

function isPortalAction(value: unknown): value is PortalAction {
  return typeof value === "string" && (PORTAL_ACTIONS as readonly string[]).includes(value);
}

// The params each action takes. Anything else is refused rather than carried into a
// token nobody reads.
const FIELDS: Record<PortalAction, readonly string[]> = {
  overnight: ["value", "reason", "undo"],
  resume_job: ["id", "reason", "note"],
  release_job: ["id", "reason"],
  fail_job: ["id", "reason"],
  close_shipped: ["id", "reason"],
  supersede_job: ["id", "reason", "replaced_by"],
  park_job: ["id", "reason", "undo"],
  unpark_job: ["id", "reason", "undo"],
  pr_close: ["namespace", "repo", "number", "reason"],
  approve_pr: ["namespace", "repo", "prs", "shas", "confirm", "reason", "undo"],
  revoke_agent: ["name"],
  site_add: ["namespace", "name", "origin", "health_path", "platform", "script", "operator"],
  site_edit: ["namespace", "revision", "name", "origin", "health_path", "platform", "script", "operator"],
  site_remove: ["namespace", "revision"],
  reset_breaker: ["namespace"],
  package_add: ["name", "repo", "formerly"],
  package_edit: ["name", "revision", "repo", "formerly"],
  package_remove: ["name", "revision"],
  canon_approve: ["id"],
  canon_reject: ["id", "reason"],
  // The plan the preview read is bound into the token beside these (Plan.bind), so a
  // caller cannot send one.
  canon_approve_all: ["reason"],
  site_repair: ["namespace", "tool"],
  sign_policy_change: ["change", "unit", "confirm", "reason"],
  // The hash its preview read is bound into the token (Plan.bind), so a caller cannot send one.
  sign_policy_from_repo: ["confirm", "reason"],
  unit_resume: ["unit", "reason"],
  automerge_resume: ["namespace", "reason"],
};


/** The action's params from a preview body: only the fields it takes, each a string,
 *  trimmed, blanks dropped. */
function paramsFrom(action: PortalAction, raw: unknown): { ok: true; params: Record<string, string> } | { ok: false; refusal: string } {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, refusal: "params must be an object of strings." };
  const allowed = FIELDS[action];
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) {
      return { ok: false, refusal: `${action} takes ${allowed.join(" and ")}; '${key}' is not one of them.` };
    }
    if (typeof value !== "string") return { ok: false, refusal: `${action}'s ${key} must be a string.` };
    if (value.trim()) params[key] = value.trim();
  }
  return { ok: true, params };
}

// bind: params the plan itself adds to the token, beside the caller's, so the perform
// carries out what this preview read (canon_approve_all binds its plan this way).
export type Plan = { ok: true; changes: string[]; audit: string[]; bind?: Record<string, string> } | { ok: false; refusal: string };

/** A revision param as a positive integer, or null. */
function revisionOf(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

const SITE_FIELDS = ["name", "origin", "health_path", "platform", "script"] as const;

function shown(value: string | null): string {
  return value === null ? "(none)" : `"${value}"`;
}

const refused = (refusal: string): Plan => ({ ok: false, refusal });

// How many added and removed lines a canon_approve preview lists before it says how many
// more there are. The whole body is in the proposal row.
const CANON_PREVIEW_LINES = 40;
const UNIT_RESUME_REASON = "unit_resume needs a reason: why the rollback that suspended the unit is answered. It is recorded in the audit row.";
const AUTOMERGE_RESUME_REASON = "automerge_resume needs a reason: why the rollbacks or reverts that paused the namespace are answered. It is recorded in the audit row.";
const CANON_REJECT_REASON = "canon_reject needs a reason: the proposer reads it, and a rejection with no reason is one nobody can act on.";

// canon_approve_all's preview, one line per proposal in the order the perform runs them:
// every rejection, then every approval, each by id.
function sweepOrder(items: readonly SweepItem[]): SweepItem[] {
  return [...items.filter((i) => i.outcome !== "approve"), ...items.filter((i) => i.outcome === "approve")];
}

function sweepChanges(items: readonly SweepItem[], reason: string | undefined, click: string): string[] {
  const approvals = items.filter((i) => i.outcome === "approve");
  const superseded = items.filter((i) => i.outcome === "superseded").length;
  const outdated = items.filter((i) => i.outcome === "outdated").length;
  const flagged = approvals.filter((i) => i.proposal.directive_lines.length);
  const line = (i: SweepItem) => {
    const p = i.proposal;
    const target = `${p.namespace}/${p.path}`;
    if (i.reason !== null) return `reject proposal ${p.id} (${target}, from ${p.proposer}): pending -> rejected, with the reason "${i.reason}". ${target} is not touched.`;
    return `approve proposal ${p.id} (${target}, from ${p.proposer}): ${p.creates ? `${target} is created` : `${target} is overwritten, the current version snapshotted first`}; ${p.added} line(s) added, ${p.removed} removed.`;
  };
  return [
    `${items.length} pending canon proposal(s): ${approvals.length} approved, ${items.length - approvals.length} rejected (${superseded} superseded, ${outdated} outdated). Rejections run first, then approvals, each its own decision; one that fails does not stop the rest.`,
    ...(flagged.length
      ? [
          `${flagged.length} approval(s) add lines that read as instructions addressed to agents. Read them before approving:`,
          ...flagged.flatMap((i) => i.proposal.directive_lines.map((l) => `instruction (proposal ${i.proposal.id}, ${i.proposal.namespace}/${i.proposal.path}): ${l}`)),
        ]
      : ["No approval adds a line that reads as an instruction addressed to agents."]),
    ...sweepOrder(items).map(line),
    ...(reason ? [`Your reason "${reason}" is recorded in the ${click} audit row.`] : []),
  ];
}

function rosterRefusal(action: "reset_breaker", namespace: string | undefined): string | null {
  if (!namespace) return `${action} needs a namespace.`;
  if (namespace === "all") {
    return `the Portal acts on one namespace at a time, so "all" is refused here. Do each of ${APP_ROSTER.join(", ")} in turn.`;
  }
  if (!(APP_ROSTER as readonly string[]).includes(namespace)) return `'${namespace}' is not on the roster (${APP_ROSTER.join(", ")}).`;
  return null;
}

/** What the action will change, read from the state now. Reads only: no D1 write and
 *  no KV put, which test/portal-actions.test.ts asserts for every action. */
async function planAction(env: Env, email: string, action: PortalAction, p: Record<string, string>, surface: Surface = "portal"): Promise<Plan> {
  const actor = adminAgentForEmail(email).actor;
  const click = `${clickAuditAction(action, p, surface)} by ${actor}`;
  if (p.undo !== undefined && p.undo !== "true") return refused(`${action}'s undo is "true" or absent; got '${p.undo}'.`);
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
          state.mode === value ? `${OVERNIGHT_MODE_KEY} is already ${value}; it is written again unchanged.` : `${OVERNIGHT_MODE_KEY}: ${state.mode} -> ${value}.`,
          ...(decision
            ? [
                `Recorded with the switch: the decision of ${decision.decided_by} on ${decision.decided_on}, "${decision.ruling}".`,
                `Reasoning recorded: ${decision.reasoning}`,
                "Hand-started VS Code tabs are unaffected and stay the default.",
              ]
            : value === "api"
              ? ["The scheduler will refuse to start a run unless it authenticates with ANTHROPIC_API_KEY and no subscription token is in use."]
              : ["No scheduled run starts. Hand-started VS Code tabs are unaffected."]),
        ],
        audit: [`overnight-set by ${actor}`, click],
      };
    }
    case "resume_job":
    case "release_job":
    case "fail_job": {
      if (!p.id) return refused(`${action} needs a job id.`);
      if (!p.reason) return refused(`${action} needs a reason. It is recorded in the audit row, and a transition with no reason is one nobody can review.`);
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      const label = `${job.id} ('${job.title}' in ${job.namespace})`;
      if (action === "resume_job") {
        if (p.note && p.note.length > MAX_RESUME_NOTE) {
          return refused(`resume_job's note is at most ${MAX_RESUME_NOTE} characters, as for the capsid_work_jobs tool; this one is ${p.note.length}.`);
        }
        if (job.status !== "blocked") {
          return refused(`${job.id} is ${job.status}, not blocked. Resume is how a job comes back off a gate; a queued job is claimed and a done or failed one is finished.`);
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
            `Your approval "${p.reason}" is recorded in the resume note the next holder reads${p.note ? `, with your note of ${p.note.length} character${p.note.length === 1 ? "" : "s"} in full` : ""}.`,
          ],
          audit: [`job-resumed by ${actor}`, click],
        };
      }
      if (action === "release_job") {
        if (job.status !== "claimed") {
          return refused(`${job.id} is ${job.status}, not claimed. Release returns a claimed job to the queue; a blocked job is resumed, a queued one is already free, and a finished one is not reopened.`);
        }
        if (job.claimed_by === actor) return refused(`${job.id} is held by ${actor} itself. A holder ends its own claim with fail or block.`);
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
      if (!p.reason) return refused("close_shipped needs a reason: what shipped, and how you know. It is the job's result summary.");
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      if (job.status !== "blocked") {
        return refused(`${job.id} is ${job.status}, not blocked. Close as shipped ends a blocked job whose work landed; a claimed job is completed by its holder, and a queued or finished one has nothing to close.`);
      }
      if (job.claimed_by === actor) {
        return refused(`${job.id} is blocked and held by ${actor} itself. A holder resumes its own gate and completes the job; close as shipped is for a job another credential blocked.`);
      }
      const shipped = shippedEvidence(job);
      return {
        ok: true,
        changes: [
          `${job.id} ('${job.title}' in ${job.namespace}): blocked -> done, with the result "Closed as shipped by ${actor}: ${p.reason}".`,
          `The outcome row credits ${job.claimed_by ?? "nobody"}, who did the work. No claim is recorded for you; one admin_complete touch records that you closed it.`,
          shipped.prs.length
            ? `The outcome verifies ${shipped.prs.length} pull request${shipped.prs.length === 1 ? "" : "s"} against GitHub: ${shipped.prs.join(", ")}${shipped.more ? ` (${shipped.more} more named, left out)` : ""}.`
            : "The job names no pull request, so the outcome verifies nothing.",
          ...(job.review_required ? ["The job needs a review: the close is refused, and nothing written, unless the newest review on its pull request approves the head."] : []),
        ],
        audit: [`job-admin-complete by ${actor}`, click],
      };
    }
    case "supersede_job": {
      if (!p.id) return refused("supersede_job needs a job id.");
      if (!p.reason) return refused("supersede_job needs a reason: what replaced this job, or why it was withdrawn.");
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      const label = `${job.id} ('${job.title}' in ${job.namespace})`;
      if (job.status !== "queued" && job.status !== "claimed") {
        return refused(`${job.id} is ${job.status}. Supersede closes a queued job, or a claimed one with no work recorded; ${job.status === "blocked" ? "a blocked job has hit a gate, so it is failed instead" : "a finished job is not rewritten"}.`);
      }
      const work = job.status === "claimed" ? workRecorded(job) : null;
      if (work) return refused(`${job.id} has work recorded on it: ${work}. Fail it instead; supersede is for a job replaced before any work was done.`);
      if (p.replaced_by) {
        if (p.replaced_by === job.id) return refused(`${job.id} cannot be replaced by itself.`);
        const replacement = await readJob(env.DB, p.replaced_by);
        if (!replacement) return refused(`no job ${p.replaced_by}. replaced_by names the job that replaces this one, and it must exist.`);
        if (replacement.namespace !== job.namespace) return refused(`${p.replaced_by} is in ${replacement.namespace} and ${job.id} is in ${job.namespace}. A job is replaced by work in its own namespace.`);
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
        return refused("park_job needs a reason in one line, at most 300 characters, saying when the job comes back (\"comes back when ...\").");
      }
      const job = await readJob(env.DB, p.id);
      if (!job) return refused(`no job ${p.id}.`);
      if (job.status !== "queued") {
        return refused(`${job.id} is ${job.status}. Park changes a queued job; a claimed or blocked one has somebody on it, so resume or supersede that instead.`);
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
        return refused(`${job.namespace} already has another open job titled '${job.title}': ${holder.id} is ${holder.status}. One open job per (namespace, title), so ${job.id} stays parked.`);
      }
      return {
        ok: true,
        changes: [`${job.id} ('${job.title}' in ${job.namespace}): parked ("${job.result_summary ?? ""}") -> queued, at priority ${job.priority}. The next free session may claim it.`],
        audit: [`job-unparked by ${actor}`, click],
      };
    }
    case "approve_pr": {
      const plan = await planApproval(env, actor, p, surface, click);
      return plan.ok ? { ok: true, changes: plan.changes, audit: plan.audit } : refused(plan.refusal);
    }
    case "sign_policy_change": {
      const plan = await planPolicyChange(env, p.change, p.unit);
      return plan.ok ? { ok: true, changes: plan.changes, audit: [`policy-changed by ${actor}`, click] } : refused(plan.error);
    }
    case "sign_policy_from_repo": {
      const plan = await planPolicyFromRepo(env);
      // A typed version, when one comes with the preview, is checked now and bound into the token.
      if (plan.ok && p.confirm && p.confirm !== plan.to) return refused(`${p.confirm} is not the version in docs/policy/auto-merge.md, which says ${plan.to}. Type ${plan.to} to sign it. Nothing was signed.`);
      return plan.ok ? { ok: true, changes: plan.changes, audit: [`policy-loaded-from-repo by ${actor}`, click], bind: { source_sha: plan.newSha } } : refused(plan.error);
    }
    case "unit_resume": {
      if (!p.reason) return refused(UNIT_RESUME_REASON);
      const plan = await planLift(env.APP_KV, p.unit);
      if (!plan.ok) return refused(plan.refusal);
      return {
        ok: true,
        changes: [`${plan.unit}: suspended since ${plan.suspension.since} ("${plan.suspension.reason}") -> lifted. The tick may merge its pull requests unattended again; a rollback after now suspends it again.`],
        audit: [`merge-unit-resumed by ${actor}`, click],
      };
    }
    case "automerge_resume": {
      if (!p.reason) return refused(AUTOMERGE_RESUME_REASON);
      const plan = await planResume(env.APP_KV, p.namespace);
      if (!plan.ok) return refused(plan.refusal);
      return {
        ok: true,
        changes: [`${plan.namespace}: auto-merge paused since ${plan.paused.since} ("${plan.paused.reason}") -> lifted. The tick may merge its pull requests unattended again; new bad merges pause it again.`],
        audit: [`auto-merge-resumed by ${actor}`, click],
      };
    }
    case "pr_close": {
      if (!p.namespace) return refused("pr_close needs the namespace whose repo holds the pull request.");
      if (!p.number || !/^[1-9][0-9]{0,9}$/.test(p.number)) return refused(`pr_close needs the pull request's number; got '${p.number ?? ""}'.`);
      if (!p.reason) return refused("pr_close needs a reason: why the pull request is closed without merging. It is recorded in the audit row.");
      let full: string;
      try {
        full = (await resolveRepo(env, p.namespace, p.repo)).full;
      } catch (err) {
        return refused(err instanceof Error ? err.message : String(err));
      }
      return {
        ok: true,
        changes: [
          `${full}#${p.number}: open -> closed, not merged. GitHub refuses it at perform if it is already closed or merged, and nothing is written then.`,
          "Its head branch is deleted as capsid_close_pr action close deletes it: never the default branch, a loop branch or a fork's.",
        ],
        audit: [`pr-closed by ${actor}`, click],
      };
    }
    case "site_add": {
      const checked = validateSite(p);
      if (!checked.ok) return refused(checked.refusal);
      const site = checked.site;
      const registered = await env.DB.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(site.namespace).first<{ namespace: string }>();
      if (!registered) return refused(`'${site.namespace}' is not a registered namespace. Register it first; a site row for an unregistered namespace is drift the watcher reports.`);
      const existing = await readSiteRow(env.DB, site.namespace);
      if (existing) return refused(`${site.namespace} already has a row (${describeSite(existing)}). Edit it instead.`);
      return {
        ok: true,
        changes: [
          `ops_sites: add ${site.namespace}, ${describeSite(site)}.`,
          site.origin
            ? `The watcher probes it from its next pass, and the Sites view lists it.`
            : `Nothing is probed for ${site.namespace}; the site-map check counts it as decided.`,
        ],
        audit: [`ops-site-added by ${actor}`, click],
      };
    }
    case "site_edit": {
      const revision = revisionOf(p.revision);
      if (revision === null) return refused("site_edit needs the revision of the row it edits.");
      const checked = validateSite(p);
      if (!checked.ok) return refused(checked.refusal);
      const site: SiteInput = checked.site;
      const before = await readSiteRow(env.DB, site.namespace);
      if (!before) return refused(`${site.namespace} has no row to edit. Add it instead.`);
      if (before.revision !== revision) return refused(`${site.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`);
      const diffs = SITE_FIELDS.filter((f) => before[f] !== site[f]).map((f) => `${f}: ${shown(before[f])} -> ${shown(site[f])}`);
      // The operator API, only when the edit names it: a form that does not show it leaves it.
      const beforeOperator = before.operator ? JSON.stringify(before.operator) : null;
      if (site.operator !== undefined && site.operator !== beforeOperator) diffs.push(`operator: ${shown(beforeOperator)} -> ${shown(site.operator)}`);
      if (diffs.length === 0) return refused(`the edit changes nothing in ${site.namespace}.`);
      const changes = [`ops_sites ${site.namespace}, revision ${revision} -> ${revision + 1}:`, ...diffs.map((d) => `  ${d}`)];
      if (before.self_probe && before.origin !== site.origin) changes.push("The origin changes, so the in-process self-probe is cleared and the site is probed over HTTP.");
      return { ok: true, changes, audit: [`ops-site-edited by ${actor}`, click] };
    }
    case "site_remove": {
      const revision = revisionOf(p.revision);
      if (!p.namespace || revision === null) return refused("site_remove needs a namespace and the revision of the row it removes.");
      const before = await readSiteRow(env.DB, p.namespace);
      if (!before) return refused(`${p.namespace} has no row to remove.`);
      if (before.revision !== revision) return refused(`${p.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`);
      const registered = await env.DB.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(p.namespace).first<{ namespace: string }>();
      return {
        ok: true,
        changes: [
          `ops_sites: remove ${p.namespace} (${describeSite(before)}). The row is kept in the audit row.`,
          before.origin ? `The watcher stops probing ${before.origin}, and its uptime ring leaves the next pass.` : `Nothing was probed for it.`,
          ...(registered ? [`${p.namespace} is still registered, so the site-map check reports it as unmapped until it has a row again.`] : []),
        ],
        audit: [`ops-site-removed by ${actor}`, click],
      };
    }
    case "package_add": {
      const checked = validatePackage(p);
      if (!checked.ok) return refused(checked.refusal);
      const existing = await readPackageRow(env.DB, checked.pkg.name);
      if (existing) return refused(`${checked.pkg.name} is already configured (${describePackage(existing)}). Edit it instead.`);
      return {
        ok: true,
        changes: [
          `ops_packages: add ${describePackage(checked.pkg)}.`,
          "The watcher reads it from its next pass: about nine requests to npm, deps.dev and GitHub per pass. The Packages view appears once a package is configured.",
        ],
        audit: [`ops-package-added by ${actor}`, click],
      };
    }
    case "package_edit": {
      const revision = revisionOf(p.revision);
      if (revision === null) return refused("package_edit needs the revision of the row it edits.");
      const checked = validatePackage(p);
      if (!checked.ok) return refused(checked.refusal);
      const before = await readPackageRow(env.DB, checked.pkg.name);
      if (!before) return refused(`${checked.pkg.name} is not configured. Add it instead.`);
      if (before.revision !== revision) return refused(`${checked.pkg.name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`);
      const diffs = (["repo", "formerly"] as const).filter((k) => before[k] !== checked.pkg[k]).map((k) => `  ${k}: ${shown(before[k])} -> ${shown(checked.pkg[k])}`);
      if (diffs.length === 0) return refused(`the edit changes nothing in ${checked.pkg.name}.`);
      return {
        ok: true,
        changes: [`ops_packages ${checked.pkg.name}, revision ${revision} -> ${revision + 1}:`, ...diffs],
        audit: [`ops-package-edited by ${actor}`, click],
      };
    }
    case "package_remove": {
      const revision = revisionOf(p.revision);
      if (!p.name || revision === null) return refused("package_remove needs a name and the revision of the row it removes.");
      const before = await readPackageRow(env.DB, p.name);
      if (!before) return refused(`${p.name} is not configured.`);
      if (before.revision !== revision) return refused(`${p.name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`);
      return {
        ok: true,
        changes: [`ops_packages: remove ${describePackage(before)}. The row is kept in the audit row, and its weekly GitHub rows stay.`],
        audit: [`ops-package-removed by ${actor}`, click],
      };
    }
    case "site_repair": {
      if (!p.namespace || !p.tool) return refused("site_repair needs a namespace and a tool.");
      const row = await readSiteRow(env.DB, p.namespace);
      if (!row?.origin) return refused(`${p.namespace} is not a configured site.`);
      if (!row.operator) return refused(row.operator_problem ?? `${p.namespace} has no operator API configured, so Capsid may call nothing on it.`);
      const bad = toolRefusal(row.operator, p.tool);
      if (bad) return refused(bad);
      if (!tokenSet(env, row.operator)) return refused(`the Capsid Worker secret ${row.operator.auth_var} is not set, so nothing can be called on ${p.namespace}.`);
      const wait = await limitRefusalFor(env, p.namespace, p.tool, new Date());
      if (wait) return refused(`${p.tool} on ${p.namespace} waits: ${wait}`);
      return {
        ok: true,
        changes: [
          `POST ${row.origin}${row.operator.path} with tool ${p.tool}, authorized by the Capsid Worker secret ${row.operator.auth_var} (the token is never shown or recorded).`,
          `The site re-derives that store from its source and reports a read-back verdict; the result is shown when it returns, up to a minute. One task_runs row (site-repair) records it.`,
        ],
        audit: [`site-repair by ${actor}`, click],
      };
    }
    case "canon_approve":
    case "canon_reject": {
      const id = revisionOf(p.id);
      if (id === null) return refused(`${action} needs the proposal id, a positive integer.`);
      if (action === "canon_reject" && !p.reason) return refused(CANON_REJECT_REASON);
      const checked = await checkProposal(env.DB, id, action === "canon_approve");
      if (!checked.ok) return refused(checked.refusal);
      const { row, current, directive } = checked;
      const target = `${row.namespace}/${row.path}`;
      if (action === "canon_reject") {
        return {
          ok: true,
          changes: [`canon proposal ${id} (${target}, from ${row.proposer} at ${row.created_at}): pending -> rejected, with the reason "${p.reason}". ${target} is not touched.`],
          audit: [`canon-rejected by ${actor}`, click],
        };
      }
      const { added, removed } = lineChanges(current, row.body);
      const shownLines = (label: string, lines: string[]) => [
        ...lines.slice(0, CANON_PREVIEW_LINES).map((l) => `${label}: ${l}`),
        ...(lines.length > CANON_PREVIEW_LINES ? [`${label}: and ${lines.length - CANON_PREVIEW_LINES} more line(s), in the proposal row`] : []),
      ];
      return {
        ok: true,
        changes: [
          current === null
            ? `${target} does not exist; it is created as ${row.proposer} proposed at ${row.created_at} (${row.mode}).`
            : `${target} is overwritten as ${row.proposer} proposed at ${row.created_at} (${row.mode}). The current version is snapshotted first, so it can be restored.`,
          `${added.length} line(s) added, ${removed.length} removed.`,
          ...(directive.length
            ? [`${directive.length} added line(s) read as instructions addressed to agents. Read them before approving:`, ...directive.map((l) => `instruction: ${l}`)]
            : ["No added line reads as an instruction addressed to agents."]),
          ...shownLines("added", added),
          ...shownLines("removed", removed),
          ...(row.title !== null || row.type !== null || row.tags !== null || row.status !== null
            ? [`metadata set by the proposal: ${[["title", row.title], ["type", row.type], ["tags", row.tags], ["status", row.status]].filter(([, v]) => v !== null).map(([k, v]) => `${k} "${v}"`).join(", ")}.`]
            : []),
        ],
        audit: [`write by ${actor}`, click],
      };
    }
    case "canon_approve_all": {
      const sweep = await readSweep(env.DB);
      if (!sweep.ok) return refused(sweep.refusal);
      const approves = sweep.items.some((i) => i.outcome === "approve");
      const rejects = sweep.items.some((i) => i.outcome !== "approve");
      return {
        ok: true,
        changes: sweepChanges(sweep.items, p.reason, clickAuditAction(action, p, surface)),
        audit: [...(rejects ? [`canon-rejected by ${actor}`] : []), ...(approves ? [`write by ${actor}`] : []), click],
        bind: { plan: sweep.key },
      };
    }
    case "revoke_agent": {
      if (!p.name) return refused("revoke_agent needs an agent name.");
      const agent = await env.DB.prepare("SELECT name, kind, revoked_at FROM agents WHERE name = ?1")
        .bind(p.name)
        .first<{ name: string; kind: string; revoked_at: string | null }>();
      if (!agent) {
        const archived = await archivedAgentByName(env.DB, p.name);
        return refused(archived ? `'${p.name}' was revoked at ${archived.revoked_at} and archived at ${archived.archived_at}.` : `no agent named '${p.name}'.`);
      }
      if (agent.revoked_at) return refused(`'${p.name}' was already revoked at ${agent.revoked_at}.`);
      // Bounded: the limit is a guard, not a page.
      const { results } = await env.DB.prepare(
        `SELECT id, title, namespace, status FROM jobs WHERE claimed_by = ?1 AND status IN ('claimed', 'blocked') ORDER BY id LIMIT 50`
      )
        .bind(agentActor(p.name))
        .all<{ id: string; title: string; namespace: string; status: string }>();
      const held = results ?? [];
      return {
        ok: true,
        changes: [
          `agent ${p.name} (${agent.kind}): live -> revoked. Its key stops resolving on the next request, and the name can never be minted again.`,
          held.length === 0
            ? `It holds no claimed or blocked job.`
            : `It holds ${held.length} job${held.length === 1 ? "" : "s"}, which stay as they are until released or failed: ${held
                .map((j) => `${j.id} (${j.status}, '${j.title}' in ${j.namespace})`)
                .join("; ")}.`,
        ],
        audit: [`agent-revoked by ${actor}`, click],
      };
    }
  }
}

// The confirmation token: base64url of the canonical claims, a dot, and the hex
// HMAC-SHA256 of that base64url text under the derived key.
export interface ConfirmClaims {
  v: 2;
  // A one-time id: a perform spends it in KV, so a confirmation is used once, by whichever
  // surface took it (controls design, D2). Version 1 tokens had none and are retired.
  jti: string;
  action: PortalAction;
  params: Record<string, string>;
  email: string;
  exp: number;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
const JTI_SHAPE = /^[0-9a-f]{32}$/;

function canonical(claims: ConfirmClaims): string {
  const params: Record<string, string> = {};
  for (const key of Object.keys(claims.params).sort()) params[key] = claims.params[key];
  return JSON.stringify({ v: claims.v, jti: claims.jti, action: claims.action, params, email: claims.email, exp: claims.exp });
}

async function confirmKey(env: Env): Promise<string> {
  // Fails closed: with no root secret there is nothing to sign with, and an empty key
  // would sign with a value anybody knows.
  if (!env.COOKIE_ENCRYPTION_KEY) throw new Error("COOKIE_ENCRYPTION_KEY is unset, so no confirmation can be signed or checked");
  return hmacHex(env.COOKIE_ENCRYPTION_KEY, TOKEN_CONTEXT);
}

async function signConfirm(env: Env, claims: ConfirmClaims): Promise<string> {
  const payload = b64urlEncode(canonical(claims));
  return `${payload}.${await hmacHex(await confirmKey(env), payload)}`;
}

export type Verified = { ok: true; claims: ConfirmClaims } | { ok: false; status: number; refusal: string };

async function verifyConfirm(env: Env, token: string, email: string, now: Date): Promise<Verified> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, status: 403, refusal: "the confirmation token is malformed: preview again." };
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  if (!timingSafeEqual(token.slice(dot + 1), await hmacHex(await confirmKey(env), payload))) {
    return { ok: false, status: 403, refusal: "the confirmation token does not verify: preview again." };
  }
  let claims: ConfirmClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload)) as ConfirmClaims;
  } catch (err) {
    // Signed by this Worker and unreadable: a defect, said so.
    return { ok: false, status: 403, refusal: `the confirmation token verifies but does not parse (${err instanceof Error ? err.message : String(err)}): preview again.` };
  }
  const paramsOk =
    claims && typeof claims.params === "object" && claims.params !== null && Object.values(claims.params).every((v) => typeof v === "string");
  if (claims?.v !== 2 || typeof claims.jti !== "string" || !JTI_SHAPE.test(claims.jti) || typeof claims.email !== "string" || typeof claims.exp !== "number" || !paramsOk) {
    return { ok: false, status: 403, refusal: "the confirmation token verifies but its claims are not the shape this Worker signs: preview again." };
  }
  if (claims.email !== email) return { ok: false, status: 403, refusal: "the confirmation was issued to another session: preview again." };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, status: 410, refusal: "the confirmation expired: preview again." };
  if (!isPortalAction(claims.action)) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(claims.action)) };
  return { ok: true, claims };
}


// ---------------------------------------------------------------------------
// The registry and its two doors.

/** One control: its name, the params it takes, whether it needs a reason, and the two
 *  steps every surface goes through. plan writes nothing. perform calls the one
 *  mutator that exists for the control, then writes the click's audit row. */
export interface Control {
  name: PortalAction;
  fields: readonly string[];
  reasonRequired: boolean;
  plan(env: Env, email: string, params: Record<string, string>, surface: Surface): Promise<Plan>;
  perform(env: Env, email: string, source: string | null, now: Date, params: ActionParams, surface: Surface): Promise<ActionResult>;
}

export const CONTROLS: readonly Control[] = PORTAL_ACTIONS.map((name) => ({
  name,
  fields: FIELDS[name],
  reasonRequired: SWITCHES.has(name),
  plan: (env, email, params, surface) => planAction(env, email, name, params, surface),
  perform: (env, email, source, now, params, surface) => performAction(env, email, source, now, name, params, surface),
}));

function controlNamed(name: unknown): Control | null {
  return typeof name === "string" ? (CONTROLS.find((c) => c.name === name) ?? null) : null;
}

const randomJti = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const NONCE_PREFIX = "control-nonce:";

export type Previewed = { ok: true; preview: PortalPreview } | { ok: false; status: number; refusal: string };

/** The preview step for either surface: validate the name and params, plan from the state
 *  now (a read, never a write), and sign a confirmation for the email. */
export async function previewControl(env: Env, email: string, name: unknown, rawParams: unknown, now: Date, surface: Surface): Promise<Previewed> {
  const control = controlNamed(name);
  if (!control) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(name ?? "")) };
  const parsed = paramsFrom(control.name, rawParams);
  if (!parsed.ok) return { ok: false, status: 400, refusal: parsed.refusal };
  const plan = await control.plan(env, email, parsed.params, surface);
  if (!plan.ok) return { ok: false, status: 400, refusal: plan.refusal };
  const exp = Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS;
  const token = await signConfirm(env, { v: 2, jti: randomJti(), action: control.name, params: { ...parsed.params, ...plan.bind }, email, exp });
  return {
    ok: true,
    preview: {
      action: control.name,
      summary: describeAction(control.name, parsed.params),
      changes: plan.changes,
      audit: plan.audit,
      token,
      expires_at: new Date(exp * 1000).toISOString(),
    },
  };
}

export type Performed = { ok: true; action: PortalAction; result: Extract<ActionResult, { ok: true }> } | { ok: false; status: number; refusal: string };

/** The perform step for either surface: the token must verify for the email, then it is
 *  spent (a confirmation is used once, whichever surface took it), then the control runs.
 *  A token is spent even when the control then refuses: the refusal is about state, and
 *  the next try starts from a fresh preview that shows the state as it is. KV has no
 *  compare-and-set, so two performs of one token inside the same instant could both
 *  pass the check; every mutator is guarded on the state it moves from, which is what
 *  stops the second. */
export async function performControl(env: Env, email: string, token: unknown, source: string | null, now: Date, surface: Surface): Promise<Performed> {
  if (typeof token !== "string") return { ok: false, status: 400, refusal: "a perform needs the token its preview returned." };
  const verified = await verifyConfirm(env, token, email, now);
  if (!verified.ok) return { ok: false, status: verified.status, refusal: verified.refusal };
  const { action, params, jti, exp } = verified.claims;
  const control = controlNamed(action);
  if (!control) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(action)) };

  const nonceKey = `${NONCE_PREFIX}${jti}`;
  if ((await env.APP_KV.get(nonceKey)) !== null) {
    return { ok: false, status: 409, refusal: "this confirmation was already used: preview again to get a new one." };
  }
  // Held until the token itself would have expired, plus a minute for clock skew, and not
  // under KV's 60 second floor.
  await env.APP_KV.put(nonceKey, now.toISOString(), { expirationTtl: Math.max(60, exp - Math.floor(now.getTime() / 1000) + 60) });

  const result = await control.perform(env, email, source, now, params, surface);
  if (!result.ok) return { ok: false, status: 400, refusal: result.refusal };
  return { ok: true, action: control.name, result };
}
