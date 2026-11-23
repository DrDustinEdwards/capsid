import { adminAgentForEmail } from "./agents";
import { archivedAgentByName } from "./agents-archive";
import { agentActor, parseScopes, SCOPE_FLAGS } from "./agents-schema";
import {
  type Surface,
  AUTOMERGE_RESUME_REASON,
  UNIT_RESUME_REASON,
  clickAuditAction,
  deleteOptionsFrom,
  switchReasonRefusal,
} from "./controls-base";
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
import { planJobAction } from "./controls-plan-jobs";
import { planSiteAction } from "./controls-plan-sites";
import type { Env } from "./env";
import { resolveRepo } from "./github";
import { breakerState } from "./job-breaker";
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
import { planPolicyChange } from "./policy-sign-change";
import { planPolicyFromRepo } from "./policy-sign-repo";
import { planApproval } from "./pr-approvals";
import { APP_ROSTER } from "./roster";

import { errorMessage } from "@dustinedwards/site-runtime/log";
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
    case "fail_job":
    case "close_shipped":
    case "supersede_job":
    case "park_job":
    case "unpark_job":
    case "run_job":
      return planJobAction(env, action, p, actor, click);
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
      // Every refusal of capsid_admin_manage_namespaces action delete_preview, from the same reader.
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
          "Its head branch is deleted as capsid_close_pr action close deletes it: never the default branch, a loop branch or a fork's.",
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
      // Bounded: the limit is a guard, not a page.
      const { results } = await env.DB.prepare(
        `SELECT id, title, namespace, status FROM jobs WHERE claimed_by = ?1 AND status IN ('claimed', 'blocked') ORDER BY id LIMIT 50`,
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
            : `It holds ${plural(held.length, "job")}, which stay as they are until released or failed: ${held
                .map((j) => `${j.id} (${j.status}, '${j.title}' in ${j.namespace})`)
                .join("; ")}.`,
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
