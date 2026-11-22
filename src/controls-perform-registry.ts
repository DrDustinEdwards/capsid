import { activateAgent, revokeAgent } from "./agents-admin";
import {
  type ActionParams,
  type ActionResult,
  required,
  type Surface,
  revisionOf,
} from "./controls-base";
import type { Env } from "./env";
import { managePr } from "./github";
import {
  removePackage,
  validatePackage,
  addPackage,
  editPackage,
  describePackage,
} from "./ops-package-config";
import { removeSite, validateSite, addSite, editSite, describeSite } from "./ops-sites";
import { runSiteRepair } from "./site-repair";
import { CAPSID_DUMP, runCapsidDump, runSiteBackups } from "./site-backup";
import { runSiteJob } from "./site-jobs";
import { auditStatement } from "./store-guards";

// The registry and operator controls' perform (src/controls-perform.ts is the dispatch):
// pull requests, agents, sites, packages, repairs, jobs and backups.

type RegistryPerformAction =
  | "pr_close"
  | "revoke_agent"
  | "activate_agent"
  | "site_add"
  | "site_edit"
  | "site_remove"
  | "package_add"
  | "package_edit"
  | "package_remove"
  | "site_repair"
  | "run_job"
  | "site_backup";

/** `commit` records that the mutator succeeded, with the summary; a refusal comes back as a result. */
export async function performRegistryAction(
  env: Env,
  actor: string,
  surface: Surface,
  now: Date,
  action: RegistryPerformAction,
  params: ActionParams,
  auditClick: (namespace: string | null, detail: object) => Promise<void>,
  commit: (text: string) => void,
): Promise<ActionResult | null> {
  switch (action) {
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
      commit(
        `Closed ${result.repo}#${number}${result.head_branch_deleted ? `; its branch ${result.head_branch} was deleted` : ""}.`,
      );
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
      commit(`Revoked the agent ${name}.`);
      await auditClick(null, { name });
      break;
    }
    case "activate_agent": {
      const name = required(params, "name");
      if (!name) return { ok: false, refusal: "activate_agent needs an agent name." };
      const result = await activateAgent(env.DB, actor, name);
      if (!result.ok)
        return { ok: false, refusal: result.refusal ?? `activating ${name} was refused.` };
      commit(`Activated the agent ${name}.`);
      await auditClick(null, { name });
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
        if (!params.namespace || revision === null)
          return {
            ok: false,
            refusal: "site_remove needs a namespace and the revision it previewed.",
          };
        result = await removeSite(env.DB, actor, params.namespace, revision);
      } else {
        const checked = validateSite(params);
        if (!checked.ok) return { ok: false, refusal: checked.refusal };
        if (action === "site_add") {
          result = await addSite(env.DB, actor, checked.site);
        } else {
          const revision = revisionOf(params.revision);
          if (revision === null)
            return { ok: false, refusal: "site_edit needs the revision it previewed." };
          result = await editSite(env.DB, actor, checked.site, revision);
        }
      }
      if (!result.ok) return { ok: false, refusal: result.refusal };
      commit(
        action === "site_add"
          ? `Added ${result.site.namespace}: ${describeSite(result.site)}.`
          : action === "site_edit"
            ? `Changed ${result.site.namespace}: ${describeSite(result.site)}.`
            : `Removed ${result.site.namespace} from the site configuration.`,
      );
      await auditClick(result.site.namespace, params);
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
        if (!params.name || revision === null)
          return {
            ok: false,
            refusal: "package_remove needs a name and the revision it previewed.",
          };
        result = await removePackage(env.DB, actor, params.name, revision);
      } else {
        const checked = validatePackage(params);
        if (!checked.ok) return { ok: false, refusal: checked.refusal };
        if (action === "package_add") {
          result = await addPackage(env.DB, actor, checked.pkg);
        } else {
          const revision = revisionOf(params.revision);
          if (revision === null)
            return { ok: false, refusal: "package_edit needs the revision it previewed." };
          result = await editPackage(env.DB, actor, checked.pkg, revision);
        }
      }
      if (!result.ok) return { ok: false, refusal: result.refusal };
      commit(
        action === "package_add"
          ? `Added ${describePackage(result.pkg)}.`
          : action === "package_edit"
            ? `Changed ${result.pkg.name}: ${describePackage(result.pkg)}.`
            : `Removed ${result.pkg.name} from the packages.`,
      );
      await auditClick(null, params);
      break;
    }
    case "site_repair": {
      // Every check runs again inside runSiteRepair: the allowlist, the token and the
      // rate limit can all change between the preview and this click.
      const namespace = required(params, "namespace");
      const tool = required(params, "tool");
      if (!namespace || !tool)
        return { ok: false, refusal: "site_repair needs a namespace and a tool." };
      const outcome = await runSiteRepair(
        env,
        { namespace, tool, actor, auto: false, via: surface },
        now,
      );
      if (!outcome.ran) return { ok: false, refusal: outcome.refusal };
      commit(
        `${namespace}: ${outcome.line}.${outcome.recorded ? "" : " The call's audit row was not written (SITE_REPAIR_NOT_RECORDED in the log)."}`,
      );
      await auditClick(namespace, {
        tool,
        ok: outcome.call.ok,
        converged: outcome.call.converged,
      });
      break;
    }
    case "run_job": {
      // Every check runs again inside runSiteJob: the configuration, the token and the
      // rate limit can all change between the preview and this click.
      const namespace = required(params, "namespace");
      const name = required(params, "name");
      if (!namespace || !name)
        return { ok: false, refusal: "run_job needs a namespace and a job name." };
      const outcome = await runSiteJob(env, { namespace, name, actor, via: surface }, now);
      if (!outcome.ran) return { ok: false, refusal: outcome.refusal };
      commit(
        `${namespace}: ${outcome.line}.${outcome.recorded ? "" : " The call's audit row was not written (SITE_JOB_NOT_RECORDED in the log)."}`,
      );
      await auditClick(namespace, {
        job: name,
        ok: outcome.ok,
      });
      break;
    }
    case "site_backup": {
      // Every check runs again inside runSiteBackups: the configuration, the tokens and the
      // rate limit can all change between the preview and this click.
      const namespace = params.namespace?.trim() || undefined;
      if (namespace === CAPSID_DUMP) {
        const dump = await runCapsidDump(env);
        if (!dump.ok) return { ok: false, refusal: dump.line };
        commit(`${dump.line}.`);
        await auditClick(namespace, { dump: true });
        break;
      }
      const outcome = await runSiteBackups(env, { namespace, actor, via: surface }, now);
      if (!outcome.ok) return { ok: false, refusal: outcome.refusal };
      if (!outcome.runs.some((r) => r.ran))
        return {
          ok: false,
          refusal: outcome.runs.map((r) => (r.ran ? "" : r.refusal)).join(" "),
        };
      const unrecorded = outcome.runs.some((r) => r.ran && !r.recorded);
      commit(
        `${outcome.runs.map((r) => `${r.namespace}: ${r.ran ? r.line : `skipped, ${r.refusal}`}`).join(". ")}.${unrecorded ? " A call's audit row was not written (SITE_BACKUP_NOT_RECORDED in the log)." : ""}`,
      );
      await auditClick(namespace ?? null, {
        sites: outcome.runs.map((r) => ({
          namespace: r.namespace,
          ran: r.ran,
          ok: r.ran ? r.call.ok : false,
        })),
      });
      break;
    }
  }
  return null;
}
