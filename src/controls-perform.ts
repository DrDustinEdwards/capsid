import { adminAgentForEmail } from "./agents";
import { activateAgent, revokeAgent } from "./agents-admin";
import { type ActionParams, type Surface, auditPrefix, deleteOptionsFrom } from "./controls-base";
import {
  namespaceNameRefusal,
  registerNamespace,
  registerRepos,
  updateNamespace,
  updateRepos,
} from "./namespace-admin";
import { deleteAsPlanned } from "./namespace-delete-perform";
import { type ActionResult, type PerformContext, required } from "./controls-perform-base";
import { performSiteAction } from "./controls-perform-sites";
import type { Env } from "./env";
import { managePr } from "./github/refs";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import type { PortalAction } from "./ops-types/portal";
import { auditStatement } from "./store-guards";
import { plural } from "@drdustinedwards/site-helpers/text";

/**
 * One action, performed by the administrator `email`: the shared mutator, then the click's audit
 * row.
 */
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
  const state: PerformContext["state"] = { committed: false, summary: "", warning: null };
  // The click's own audit row, naming the admin and the click's address (sourceAddress); the shared
  // mutators' rows do not always say who asked.
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
  const c: PerformContext = {
    env,
    agent,
    actor,
    now,
    params,
    surface,
    state,
    auditClick,
  };
  try {
    switch (action) {
      case "namespace_add":
      case "namespace_edit": {
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
        // deleteAsPlanned reads the plan again, applies every refusal again, and requires the fingerprint
        // the preview bound: anything counted that moved since refuses it.
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
          allow_policy_paths: options.opts.allowPolicyPaths,
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
      case "site_backup":
      case "run_job": {
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
        const result = await managePr(env, namespace, number, "close", "squash", repo);
        state.committed = true;
        state.summary = `Closed ${result.repo}#${number}.`;
        // managePr writes no audit row of its own, so the control writes the change's row.
        await env.DB.batch([
          auditStatement(env.DB, actor, "pr-closed", namespace, null, {
            repo: result.repo,
            number,
            reason,
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
      return {
        ok: true,
        summary: state.summary,
        warning: [state.warning, warning].filter(Boolean).join(" "),
      };
    }
    return { ok: false, refusal: message };
  }
  return { ok: true, summary: state.summary, warning: state.warning };
}
