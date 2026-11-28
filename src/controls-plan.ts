import { adminAgentForEmail } from "./agents";
import { archivedAgentByName } from "./agents-archive";
import { parseScopes, SCOPE_FLAGS } from "./agents-schema";
import { type Surface, clickAuditAction, deleteOptionsFrom } from "./controls-base";
import {
  ALREADY_REGISTERED,
  namespaceNameRefusal,
  namespaceRepos,
  NOT_REGISTERED,
  registerRepos,
  reposDigest,
  updateRepos,
} from "./namespace-admin";
import { deleteRefusals, planFingerprint, readDeletePlan, summarize } from "./namespace-delete";
import { type Plan, refused } from "./controls-plan-base";
import { planSiteAction } from "./controls-plan-sites";
import type { Env } from "./env";
import { resolveRepo } from "./github/client";
import type { PortalAction } from "./ops-types/portal";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// A control's preview (src/controls.ts is the core): reads the current state, writes nothing, and
// returns what will change and the audit rows it will write.

/**
 * What the action will change, read from the state now. Reads only: no D1 write and no KV put,
 * which test/portal-actions.test.ts asserts for every action.
 */
export async function planAction(
  env: Env,
  email: string,
  action: PortalAction,
  p: Record<string, string>,
  surface: Surface = "portal",
): Promise<Plan> {
  const actor = adminAgentForEmail(email).actor;
  const click = `${clickAuditAction(action, surface)} by ${actor}`;
  switch (action) {
    case "namespace_add": {
      const bad = namespaceNameRefusal(p.namespace);
      if (bad) return refused(bad);
      const mapped = registerRepos(p);
      if (!mapped.ok) return refused(mapped.refusal);
      if ((await namespaceRepos(env.DB, p.namespace)) !== null)
        return refused(ALREADY_REGISTERED(p.namespace));
      return {
        ok: true,
        changes: [
          `namespaces: add ${p.namespace}, mapped to ${mapped.list.map((r) => `${r.repo} (${r.label})`).join(", ")}. The repo tools resolve through this mapping, so it is what an agent scoped to ${p.namespace} may reach.`,
          `No driver agent is minted: a mint hands out a key, so it stays with capsid_admin_manage_agents. Until a site row is added (or one saying it serves no site), the site-map check reports ${p.namespace} as unmapped.`,
        ],
        audit: [`register_namespace by ${actor}`, click],
      };
    }
    case "namespace_edit": {
      const bad = namespaceNameRefusal(p.namespace);
      if (bad) return refused(bad);
      const mapped = updateRepos(p.repos);
      if (!mapped.ok) return refused(mapped.refusal);
      const previous = await namespaceRepos(env.DB, p.namespace);
      if (previous === null) return refused(NOT_REGISTERED(p.namespace));
      const next = JSON.stringify(mapped.list);
      if (previous === next)
        return refused(`the edit changes nothing in ${p.namespace}'s repo mapping.`);
      return {
        ok: true,
        changes: [
          `namespaces ${p.namespace}: repos ${previous} -> ${next}.`,
          "The prior mapping is recorded in the audit row. The namespace is not renamed and its documents do not move.",
        ],
        audit: [`update_namespace by ${actor}`, click],
        bind: { from: await reposDigest(previous) },
      };
    }
    case "namespace_remove": {
      const bad = namespaceNameRefusal(p.namespace);
      if (bad) return refused(bad);
      const options = deleteOptionsFrom(p);
      if (!options.ok) return refused(options.refusal);
      const plan = await readDeletePlan(env.DB, p.namespace);
      const refusals = deleteRefusals(plan, options.opts);
      if (refusals.length) return refused(refusals.join(" "));
      const { will_delete, will_keep } = summarize(plan);
      return {
        ok: true,
        changes: [
          ...will_delete.map((line) => `Deleted: ${line}.`),
          ...will_keep.map((line) => `Kept: ${line}.`),
        ],
        audit: [`namespace-delete by ${actor}`, click],
        bind: { plan: planFingerprint(plan) },
      };
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
    case "run_job":
      return planSiteAction(env, action, p, actor, click);
    case "pr_close": {
      if (!p.namespace)
        return refused("pr_close needs the namespace whose repo holds the pull request.");
      if (!p.number || !/^[1-9][0-9]{0,9}$/.test(p.number))
        return refused(`pr_close needs the pull request's number; got '${p.number ?? ""}'.`);
      if (!p.reason)
        return refused(
          "pr_close needs a reason: why the pull request is closed without merging. It is recorded in the audit row.",
        );
      let full: string;
      try {
        full = (await resolveRepo(env, p.namespace, p.repo)).full;
      } catch (err) {
        return refused(errorMessage(err));
      }
      return {
        ok: true,
        changes: [
          `${full}#${p.number}: open -> closed, not merged. GitHub refuses it at perform if it is already closed or merged, and nothing is written then.`,
          "Its head branch is deleted as capsid_close_pr action close deletes it: never the default branch or a fork's.",
        ],
        audit: [`pr-closed by ${actor}`, click],
      };
    }
    case "revoke_agent": {
      if (!p.name) return refused("revoke_agent needs an agent name.");
      const agent = await env.DB.prepare(
        "SELECT name, kind, revoked_at FROM agents WHERE name = ?1",
      )
        .bind(p.name)
        .first<{ name: string; kind: string; revoked_at: string | null }>();
      if (!agent) {
        const archived = await archivedAgentByName(env.DB, p.name);
        return refused(
          archived
            ? `'${p.name}' was revoked at ${archived.revoked_at} and archived at ${archived.archived_at}.`
            : `no agent named '${p.name}'.`,
        );
      }
      if (agent.revoked_at)
        return refused(`'${p.name}' was already revoked at ${agent.revoked_at}.`);
      return {
        ok: true,
        changes: [
          `agent ${p.name} (${agent.kind}): live -> revoked. Its key stops resolving on the next request, and the name can never be minted again.`,
        ],
        audit: [`agent-revoked by ${actor}`, click],
      };
    }
    case "activate_agent": {
      if (!p.name) return refused("activate_agent needs an agent name.");
      const agent = await env.DB.prepare(
        "SELECT name, kind, scopes, created_by, created_at FROM agents WHERE name = ?1 AND revoked_at IS NULL AND pending = 1",
      )
        .bind(p.name)
        .first<{
          name: string;
          kind: string;
          scopes: string;
          created_by: string;
          created_at: string;
        }>();
      if (!agent) return refused(`no live agent named '${p.name}' is waiting for activation.`);
      const scopes = parseScopes(agent.scopes);
      const flags = SCOPE_FLAGS.filter((f) => scopes.flags[f]);
      const reach = scopes.namespaces === "*" ? "every namespace" : scopes.namespaces.join(", ");
      return {
        ok: true,
        changes: [
          `agent ${agent.name} (${agent.kind}): waiting -> active. Its key resolves from the next request.`,
          `Minted by ${agent.created_by} at ${agent.created_at}, for ${reach} with ${scopes.grants.join(", ") || "no grants"}${flags.length ? ` and the flags ${flags.join(", ")}` : ""}. If you did not ask for this key, revoke it instead.`,
        ],
        audit: [`agent-activated by ${actor}`, click],
      };
    }
  }
}
