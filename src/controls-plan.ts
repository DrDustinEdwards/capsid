import { adminAgentForEmail } from "./agents";
import { archivedAgentByName } from "./agents-archive";
import { agentActor } from "./agents-schema";
import { type SweepItem, checkProposal, lineChanges, readSweep } from "./canon";
import {
  type Surface,
  AUTOMERGE_RESUME_REASON,
  CANON_REJECT_REASON,
  UNIT_RESUME_REASON,
  clickAuditAction,
  revisionOf,
  shippedEvidence,
  sweepOrder,
  switchReasonRefusal,
} from "./controls-base";
import type { Env } from "./env";
import { resolveRepo } from "./github";
import { breakerState } from "./job-breaker";
import { openTitleHolder } from "./jobs-edit";
import { resumeDestination, workRecorded } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { MAX_RESUME_NOTE } from "./limits";
import { planResume } from "./merge-safety";
import { planLift } from "./merge-units";
import { validatePackage, readPackageRow, describePackage } from "./ops-packages";
import { validateSite, readSiteRow, describeSite, type SiteInput } from "./ops-sites";
import type { PortalAction } from "./ops-types/portal";
import { overnightValueRefusal, overnightState, type OvernightMode, decisionFor, OVERNIGHT_MODE_KEY } from "./overnight";
import { planPolicyChange, planPolicyFromRepo } from "./policy-sign";
import { planApproval } from "./pr-approvals";
import { APP_ROSTER } from "./roster";
import { toolRefusal, tokenSet } from "./site-operator";
import { limitRefusalFor } from "./site-repair";

// A control's preview (src/controls.ts is the core): reads the current state, writes
// nothing, and returns what will change and the audit rows it will write.

// bind: params the plan itself adds to the token, beside the caller's, so the perform
// carries out what this preview read (canon_approve_all binds its plan this way).
export type Plan = { ok: true; changes: string[]; audit: string[]; bind?: Record<string, string> } | { ok: false; refusal: string };

const SITE_FIELDS = ["name", "origin", "health_path", "platform", "script"] as const;

function shown(value: string | null): string {
  return value === null ? "(none)" : `"${value}"`;
}

const refused = (refusal: string): Plan => ({ ok: false, refusal });

// How many added and removed lines a canon_approve preview lists before it says how many
// more there are. The whole body is in the proposal row.
const CANON_PREVIEW_LINES = 40;
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
export async function planAction(env: Env, email: string, action: PortalAction, p: Record<string, string>, surface: Surface = "portal"): Promise<Plan> {
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
