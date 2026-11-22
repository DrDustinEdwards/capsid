import { adminAgentForEmail } from "./agents";
import {
  type ActionParams,
  type ActionResult,
  required,
  type Surface,
  AUTOMERGE_RESUME_REASON,
  UNIT_RESUME_REASON,
  SWITCHES,
  auditPrefix,
  clickAuditAction,
  deleteOptionsFrom,
  shippedEvidence,
  switchReasonRefusal,
} from "./controls-base";
import {
  namespaceNameRefusal,
  registerNamespace,
  registerRepos,
  updateNamespace,
  updateRepos,
} from "./namespace-admin";
import { deleteAsPlanned } from "./namespace-delete-perform";
import { setSiteKey } from "./site-key";
import { performRegistryAction } from "./controls-perform-registry";
import type { Env } from "./env";
import { resetBreaker } from "./job-breaker";
import { parkJob, unparkJob } from "./jobs-park";
import { resumeJob, releaseJob, adminFailJob, completeAsCaller, supersedeJob } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { resumeNamespace } from "./merge-safety";
import { liftSuspension } from "./merge-units";
import type { PortalAction } from "./ops-types/portal";
import { overnightValueRefusal, setOvernight } from "./overnight";
import { performPolicyChange, performPolicyFromRepo } from "./policy-sign";
import { planApproval, performApproval } from "./pr-approvals";
import { auditStatement } from "./store-guards";
import { plural } from "@drdustinedwards/site-helpers/text";

// A control's perform (src/controls.ts is the core): the one dispatch to the shared mutators.

/** One action, performed by the administrator `email`: the shared mutator the MCP tool
 *  calls, then the click's audit row. Nothing here reimplements a transition. */
export async function performAction(
  env: Env,
  email: string,
  source: string | null,
  now: Date,
  action: PortalAction,
  params: ActionParams,
  surface: Surface = "portal",
): Promise<ActionResult> {
  const agent = adminAgentForEmail(email);
  const actor = agent.actor;
  // Set once the mutator succeeds, so the catch knows whether the action happened.
  let committed = false;
  let summary = "";
  // The switches: a reason in both directions, checked again because a token signed before
  // this rule could lack one. The reason and whether this is an Undo go in the click row.
  const switchReason = SWITCHES.has(action) ? required(params, "reason") : null;
  if (SWITCHES.has(action) && !switchReason)
    return { ok: false, refusal: switchReasonRefusal(action) };
  const undo = params.undo === "true";
  const click = clickAuditAction(action, params, surface);
  // The click's own audit row, naming the admin and the click's address (sourceAddress); the
  // shared mutators' rows do not always say who asked.
  const auditClick = async (
    namespace: string | null,
    detail: object,
    name = `${auditPrefix(surface)}${action}`,
  ) => {
    await env.DB.batch([
      auditStatement(env.DB, actor, name, namespace, null, {
        ...detail,
        surface,
        source_address: source,
      }),
    ]);
  };
  const switchDetail = (result: object) => ({
    ...result,
    reason: switchReason,
    ...(undo ? { undo: true } : {}),
  });
  try {
    switch (action) {
      case "reset_breaker": {
        const namespace = required(params, "namespace");
        if (!namespace) return { ok: false, refusal: "reset_breaker needs a namespace." };
        const result = await resetBreaker(env, actor, now, { namespace });
        if (!result.ok) return { ok: false, refusal: result.error };
        committed = true;
        summary = `Reset the circuit breaker for ${namespace}.`;
        await auditClick(namespace, result.state);
        break;
      }
      case "overnight": {
        const value = required(params, "value");
        const bad = overnightValueRefusal(value ?? undefined);
        if (bad) return { ok: false, refusal: bad };
        const result = await setOvernight(env, actor, now, {
          value: value ?? undefined,
          reason: switchReason ?? undefined,
        });
        committed = true;
        summary =
          result.mode === "off"
            ? "Turned the overnight run off."
            : `Set the overnight run to run on ${result.mode === "api" ? "the API key" : "the subscription"}.`;
        await auditClick(
          null,
          switchDetail({
            mode: result.mode,
            ...(result.decision ? { decision: result.decision } : {}),
          }),
          click,
        );
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
        await auditClick(result.job?.namespace ?? null, {
          id,
          reason,
          ...(note ? { note } : {}),
        });
        break;
      }
      case "close_shipped": {
        const id = required(params, "id");
        const reason = required(params, "reason");
        if (!id) return { ok: false, refusal: "close_shipped needs a job id." };
        if (!reason)
          return {
            ok: false,
            refusal:
              "close_shipped needs a reason: what shipped, and how you know. It is the job's result summary.",
          };
        const job = await readJob(env.DB, id);
        if (!job) return { ok: false, refusal: `no job ${id}.` };
        const shipped = shippedEvidence(job);
        const result = await completeAsCaller(env, agent, now, id, {
          result_summary: `Closed as shipped by ${actor}: ${reason}`,
          ...(shipped.result_ref ? { result_ref: shipped.result_ref } : {}),
          ...(shipped.prs.length ? { evidence: { prs: shipped.prs } } : {}),
        });
        if (!result.ok)
          return { ok: false, refusal: result.refusal ?? "close_shipped was refused." };
        committed = true;
        summary = `Closed ${id} as shipped; the outcome is credited to ${job.claimed_by ?? "its holder"}.`;
        await auditClick(job.namespace, {
          id,
          reason,
          held_by: job.claimed_by,
          prs: shipped.prs.length,
        });
        break;
      }
      case "supersede_job": {
        const id = required(params, "id");
        const reason = required(params, "reason");
        if (!id) return { ok: false, refusal: "supersede_job needs a job id." };
        if (!reason)
          return {
            ok: false,
            refusal:
              "supersede_job needs a reason: what replaced this job, or why it was withdrawn.",
          };
        const replaced_by = required(params, "replaced_by") ?? undefined;
        const result = await supersedeJob(env, agent, now, id, { reason, replaced_by });
        if (!result.ok)
          return { ok: false, refusal: result.refusal ?? "supersede_job was refused." };
        committed = true;
        summary = `Superseded ${id}${replaced_by ? ` with ${replaced_by}` : ""}.`;
        await auditClick(result.job?.namespace ?? null, {
          id,
          reason,
          ...(replaced_by ? { replaced_by } : {}),
        });
        break;
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
        committed = true;
        summary = action === "park_job" ? `Parked ${id}.` : `Unparked ${id}; it is queued again.`;
        await auditClick(
          result.job?.namespace ?? null,
          { id, reason, ...(undo ? { undo: true } : {}) },
          click,
        );
        break;
      }
      case "approve_pr": {
        // Planned again from the state now: the heads, the classes and the open approvals
        // may have moved since the preview, and the approval is of what is true now.
        const clean = Object.fromEntries(
          Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"),
        );
        const plan = await planApproval(env, actor, clean, surface, click);
        if (!plan.ok) return { ok: false, refusal: plan.refusal };
        summary = await performApproval(env, actor, plan, required(params, "reason"), now);
        committed = true;
        await auditClick(
          plan.namespace,
          {
            repo: plan.repo,
            prs: plan.targets.map((t) => ({ pr: t.number, head_sha: t.head_sha, class: t.class })),
            approval_surface: plan.surface,
            ...(undo ? { undo: true } : {}),
          },
          click,
        );
        break;
      }
      case "sign_policy_change": {
        // Planned again from the policy now, and refused unless the new version is typed.
        const done = await performPolicyChange(
          env,
          actor,
          required(params, "change") ?? undefined,
          required(params, "unit") ?? undefined,
          required(params, "confirm") ?? undefined,
        );
        if (!done.ok) return { ok: false, refusal: done.error };
        summary = done.summary;
        committed = true;
        await auditClick(
          "capsid",
          {
            change: params.change,
            unit: params.unit,
            confirm: params.confirm,
            reason: required(params, "reason"),
          },
          click,
        );
        break;
      }
      case "sign_policy_from_repo": {
        // The file is read again and must read as the preview's did (the hash the token
        // binds), and the typed version must be the file's.
        const done = await performPolicyFromRepo(
          env,
          actor,
          required(params, "confirm") ?? undefined,
          required(params, "source_sha") ?? undefined,
        );
        if (!done.ok) return { ok: false, refusal: done.error };
        summary = done.summary;
        committed = true;
        await auditClick(
          "capsid",
          {
            confirm: params.confirm,
            source_sha: params.source_sha,
            reason: required(params, "reason"),
          },
          click,
        );
        break;
      }
      case "unit_resume": {
        const reason = required(params, "reason");
        if (!reason) return { ok: false, refusal: UNIT_RESUME_REASON };
        const done = await liftSuspension(
          env,
          actor,
          required(params, "unit") ?? undefined,
          reason,
          now,
        );
        if (!done.ok) return { ok: false, refusal: done.refusal };
        summary = done.summary;
        committed = true;
        await auditClick(
          (params.unit ?? "").split("/")[0]!.trim() || null,
          { unit: params.unit, reason },
          click,
        );
        break;
      }
      case "automerge_resume": {
        const reason = required(params, "reason");
        if (!reason) return { ok: false, refusal: AUTOMERGE_RESUME_REASON };
        const done = await resumeNamespace(
          env,
          actor,
          required(params, "namespace") ?? undefined,
          reason,
          now,
        );
        if (!done.ok) return { ok: false, refusal: done.refusal };
        summary = done.summary;
        committed = true;
        await auditClick(
          (params.namespace ?? "").trim() || null,
          { namespace: params.namespace, reason },
          click,
        );
        break;
      }
      case "namespace_add":
      case "namespace_edit": {
        // Checked again, as the site controls are: the token binds the params, not the rules.
        const namespace = required(params, "namespace") ?? undefined;
        const bad = namespaceNameRefusal(namespace);
        if (bad || !namespace) return { ok: false, refusal: bad ?? `${action} needs a namespace.` };
        if (action === "namespace_add") {
          const mapped = registerRepos({
            repo: required(params, "repo") ?? undefined,
            label: required(params, "label") ?? undefined,
            repos: required(params, "repos") ?? undefined,
          });
          if (!mapped.ok) return { ok: false, refusal: mapped.refusal };
          const done = await registerNamespace(env.DB, actor, namespace, mapped.list);
          if (!done.ok) return { ok: false, refusal: done.refusal };
          committed = true;
          summary = `Registered ${namespace}, mapped to ${mapped.list.map((r) => r.repo).join(", ")}.`;
          await auditClick(namespace, {
            namespace,
            repos: mapped.list,
          });
        } else {
          const mapped = updateRepos(required(params, "repos") ?? undefined);
          if (!mapped.ok) return { ok: false, refusal: mapped.refusal };
          const from = required(params, "from");
          if (!from)
            return {
              ok: false,
              refusal: "namespace_edit needs the mapping its preview read: preview again.",
            };
          const done = await updateNamespace(env.DB, actor, namespace, mapped.list, from);
          if (!done.ok) return { ok: false, refusal: done.refusal };
          committed = true;
          summary = `Changed ${namespace}'s repo mapping to ${mapped.list.map((r) => `${r.repo} (${r.label})`).join(", ")}.`;
          await auditClick(namespace, {
            namespace,
            repos: mapped.list,
            previous: done.previous,
          });
        }
        break;
      }
      case "namespace_remove": {
        // deleteAsPlanned reads the plan again, applies every refusal again, and requires the
        // fingerprint the preview bound: anything counted that moved since refuses it.
        const namespace = required(params, "namespace") ?? undefined;
        const bad = namespaceNameRefusal(namespace);
        if (bad || !namespace)
          return { ok: false, refusal: bad ?? "namespace_remove needs a namespace." };
        const options = deleteOptionsFrom(params);
        if (!options.ok) return { ok: false, refusal: options.refusal };
        const signedPlan = required(params, "plan");
        if (!signedPlan)
          return {
            ok: false,
            refusal: "namespace_remove needs the plan its preview read: preview again.",
          };
        const done = await deleteAsPlanned(env, actor, namespace, options.opts, signedPlan);
        if (!done.ok) return { ok: false, refusal: done.refusal };
        const data = done.data as {
          documents_deleted: number;
          edges_removed: number;
          ops_site_removed: boolean;
        };
        committed = true;
        summary = `Deleted ${namespace}: ${plural(data.documents_deleted, "live document")} (each snapshotted first), ${plural(data.edges_removed, "link")}${data.ops_site_removed ? ", its site row" : ""} and its registration.`;
        await auditClick(namespace, {
          namespace,
          cascade: options.opts.cascade,
          allow_improve_paths: options.opts.allowImprovePaths,
          documents_deleted: data.documents_deleted,
          edges_removed: data.edges_removed,
          ops_site_removed: data.ops_site_removed,
        });
        break;
      }
      case "site_key_rotate": {
        // setSiteKey checks the token and the site row again, mints, sets the site then
        // Carrel, and writes set_site_key. The value never leaves it.
        const namespace = required(params, "namespace") ?? undefined;
        const bad = namespaceNameRefusal(namespace);
        if (bad || !namespace)
          return { ok: false, refusal: bad ?? "site_key_rotate needs a namespace." };
        const result = await setSiteKey(env, actor, namespace);
        // The site refused: nothing changed, so it is a refusal (its set_site_key row records the attempt).
        if (!result.site.set)
          return {
            ok: false,
            refusal: `${result.note} ${result.site.script}: ${result.site.error ?? "not set"}`,
          };
        committed = true;
        summary = result.matched
          ? `Rotated ${namespace}'s site key: set on ${result.site.script} and on ${result.carrel.script}. The value is not shown anywhere.`
          : `${result.note} ${result.carrel.script}: ${result.carrel.error ?? "not set"}`;
        await auditClick(namespace, {
          namespace,
          site_set: result.site.set,
          carrel_set: result.carrel.set,
          matched: result.matched,
        });
        break;
      }
      default: {
        const refusal = await performRegistryAction(
          env,
          actor,
          surface,
          now,
          action,
          params,
          auditClick,
          (text) => {
            committed = true;
            summary = text;
          },
        );
        if (refusal) return refusal;
        break;
      }
    }
  } catch (err) {
    const message = errorMessage(err);
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
