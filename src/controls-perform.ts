import { adminAgentForEmail } from "./agents";
import { activateAgent, revokeAgent } from "./agents-admin";
import {
  type ActionParams,
  type Surface,
  AUTOMERGE_RESUME_REASON,
  UNIT_RESUME_REASON,
  SWITCHES,
  auditPrefix,
  clickAuditAction,
  deleteOptionsFrom,
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
import { type ActionResult, type PerformContext, required } from "./controls-perform-base";
import { performJobAction } from "./controls-perform-jobs";
import { performSiteAction } from "./controls-perform-sites";
import type { Env } from "./env";
import { managePr } from "./github";
import { resetBreaker } from "./job-breaker";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { resumeNamespace } from "./merge-safety";
import { liftSuspension } from "./merge-units";
import type { PortalAction } from "./ops-types/portal";
import { overnightValueRefusal, setOvernight } from "./overnight";
import { performPolicyChange } from "./policy-sign-change";
import { performPolicyFromRepo } from "./policy-sign-repo";
import { planApproval, performApproval } from "./pr-approvals";
import { auditStatement } from "./store-guards";
import { plural } from "@drdustinedwards/site-helpers/text";

// A control's perform (src/controls.ts is the core): the one dispatch to the shared mutators.

/** One action, performed by the administrator `email`: the shared mutator, then the click's audit row. */
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
  const state = { committed: false, summary: "" };
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
  const c: PerformContext = {
    env,
    agent,
    actor,
    now,
    params,
    surface,
    state,
    auditClick,
    switchDetail,
    switchReason,
    undo,
    click,
  };
  try {
    switch (action) {
      case "reset_breaker": {
        const namespace = required(params, "namespace");
        if (!namespace) return { ok: false, refusal: "reset_breaker needs a namespace." };
        const result = await resetBreaker(env, actor, now, { namespace });
        if (!result.ok) return { ok: false, refusal: result.error };
        state.committed = true;
        state.summary = `Reset the circuit breaker for ${namespace}.`;
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
        state.committed = true;
        state.summary =
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
      case "fail_job":
      case "close_shipped":
      case "supersede_job":
      case "park_job":
      case "unpark_job":
      case "run_job": {
        const r = await performJobAction(c, action);
        if (r) return r;
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
        state.summary = await performApproval(env, actor, plan, required(params, "reason"), now);
        state.committed = true;
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
        state.summary = done.summary;
        state.committed = true;
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
        state.summary = done.summary;
        state.committed = true;
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
      case "unit_resume":
      case "automerge_resume": {
        const unit = action === "unit_resume";
        const field = unit ? "unit" : "namespace";
        const reason = required(params, "reason");
        if (!reason)
          return { ok: false, refusal: unit ? UNIT_RESUME_REASON : AUTOMERGE_RESUME_REASON };
        const target = required(params, field) ?? undefined;
        const done = unit
          ? await liftSuspension(env, actor, target, reason, now)
          : await resumeNamespace(env, actor, target, reason, now);
        if (!done.ok) return { ok: false, refusal: done.refusal };
        state.summary = done.summary;
        state.committed = true;
        await auditClick(
          (params[field] ?? "").split("/")[0]!.trim() || null,
          { [field]: params[field], reason },
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
          state.committed = true;
          state.summary = `Registered ${namespace}, mapped to ${mapped.list.map((r) => r.repo).join(", ")}.`;
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
          state.committed = true;
          state.summary = `Changed ${namespace}'s repo mapping to ${mapped.list.map((r) => `${r.repo} (${r.label})`).join(", ")}.`;
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
        state.committed = true;
        state.summary = `Deleted ${namespace}: ${plural(data.documents_deleted, "live document")} (each snapshotted first), ${plural(data.edges_removed, "link")}${data.ops_site_removed ? ", its site row" : ""} and its registration.`;
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
      case "site_key_rotate":
      case "site_add":
      case "site_edit":
      case "site_remove":
      case "package_add":
      case "package_edit":
      case "package_remove":
      case "site_repair":
      case "site_backup": {
        const r = await performSiteAction(c, action);
        if (r) return r;
        break;
      }
      case "pr_close": {
        const namespace = required(params, "namespace");
        const number = Number(required(params, "number"));
        const reason = required(params, "reason");
        if (!namespace || !Number.isInteger(number) || number < 1)
          return {
            ok: false,
            refusal: "pr_close needs a namespace and the pull request's number.",
          };
        if (!reason)
          return {
            ok: false,
            refusal: "pr_close needs a reason: why the pull request is closed without merging.",
          };
        const repo = required(params, "repo") ?? undefined;
        // Only the close shape comes back from action "close".
        const result = (await managePr(env, namespace, number, "close", "squash", repo)) as {
          repo: string;
          head_branch: string | null;
          head_branch_deleted: boolean;
        };
        state.committed = true;
        state.summary = `Closed ${result.repo}#${number}${result.head_branch_deleted ? `; its branch ${result.head_branch} was deleted` : ""}.`;
        // managePr writes no audit row of its own (the guardedWrite behind capsid_close_pr action close does),
        // so the control writes the change's row beside the click row.
        await env.DB.batch([
          auditStatement(env.DB, actor, "pr-closed", namespace, null, {
            repo: result.repo,
            number,
            reason,
            head_branch: result.head_branch,
            head_branch_deleted: result.head_branch_deleted,
          }),
        ]);
        await auditClick(namespace, {
          repo: result.repo,
          number,
          reason,
        });
        break;
      }
      case "revoke_agent": {
        const name = required(params, "name");
        if (!name) return { ok: false, refusal: "revoke_agent needs an agent name." };
        const result = await revokeAgent(env.DB, actor, name);
        if (!result.ok)
          return { ok: false, refusal: result.refusal ?? `revoking ${name} was refused.` };
        state.committed = true;
        state.summary = `Revoked the agent ${name}.`;
        await auditClick(null, { name });
        break;
      }
      case "activate_agent": {
        const name = required(params, "name");
        if (!name) return { ok: false, refusal: "activate_agent needs an agent name." };
        const result = await activateAgent(env.DB, actor, name);
        if (!result.ok)
          return { ok: false, refusal: result.refusal ?? `activating ${name} was refused.` };
        state.committed = true;
        state.summary = `Activated the agent ${name}.`;
        await auditClick(null, { name });
        break;
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    if (state.committed) {
      // The action happened; only the Portal's own audit row failed, so no refusal.
      const warning = `${action} completed, but the Portal audit row naming ${actor} was not written: ${message}`;
      logEvent("PORTAL_ACTION_AUDIT_FAILED", { message: warning }, { level: "error" });
      return { ok: true, summary: state.summary, warning };
    }
    return { ok: false, refusal: message };
  }
  return { ok: true, summary: state.summary, warning: null };
}
