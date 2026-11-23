import { revisionOf } from "./controls-base";
import { namespaceNameRefusal } from "./namespace-admin";
import { setSiteKey } from "./site-key";
import { type ActionResult, type PerformContext, required } from "./controls-perform-base";
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
// Performs the site controls, dispatched from performAction (src/controls-perform.ts). Returns a
// refusal, or null once the mutator has run and state holds its summary.

export async function performSiteAction(
  c: PerformContext,
  action:
    | "site_key_rotate"
    | "site_add"
    | "site_edit"
    | "site_remove"
    | "package_add"
    | "package_edit"
    | "package_remove"
    | "site_repair"
    | "site_backup",
): Promise<ActionResult | null> {
  const { env, actor, now, params, surface, state, auditClick } = c;
  switch (action) {
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
      state.committed = true;
      state.summary = result.matched
        ? `Rotated ${namespace}'s site key: set on ${result.site.script} and on ${result.carrel.script}. The value is not shown anywhere.`
        : `${result.note} ${result.carrel.script}: ${result.carrel.error ?? "not set"}`;
      await auditClick(namespace, {
        namespace,
        site_set: result.site.set,
        carrel_set: result.carrel.set,
        matched: result.matched,
      });
      return null;
    }
    case "site_add":
    case "site_edit":
    case "site_remove": {
      // Checked again here: the rules could have changed under a token signed before a deploy.
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
      state.committed = true;
      state.summary =
        action === "site_add"
          ? `Added ${result.site.namespace}: ${describeSite(result.site)}.`
          : action === "site_edit"
            ? `Changed ${result.site.namespace}: ${describeSite(result.site)}.`
            : `Removed ${result.site.namespace} from the site configuration.`;
      await auditClick(result.site.namespace, params);
      return null;
    }
    case "package_add":
    case "package_edit":
    case "package_remove": {
      // Checked again here, as the site controls are.
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
      state.committed = true;
      state.summary =
        action === "package_add"
          ? `Added ${describePackage(result.pkg)}.`
          : action === "package_edit"
            ? `Changed ${result.pkg.name}: ${describePackage(result.pkg)}.`
            : `Removed ${result.pkg.name} from the packages.`;
      await auditClick(null, params);
      return null;
    }
    case "site_repair": {
      // Every check runs again inside runSiteRepair: the allowlist, token and rate limit can change before the click.
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
      state.committed = true;
      state.summary = `${namespace}: ${outcome.line}.${outcome.recorded ? "" : " The call's audit row was not written (SITE_REPAIR_NOT_RECORDED in the log)."}`;
      await auditClick(namespace, {
        tool,
        ok: outcome.call.ok,
        converged: outcome.call.converged,
      });
      return null;
    }
    case "site_backup": {
      // Every check runs again inside runSiteBackups: the configuration, tokens and rate limit can change before the click.
      const namespace = params.namespace?.trim() || undefined;
      if (namespace === CAPSID_DUMP) {
        const dump = await runCapsidDump(env);
        if (!dump.ok) return { ok: false, refusal: dump.line };
        state.committed = true;
        state.summary = `${dump.line}.`;
        await auditClick(namespace, { dump: true });
        return null;
      }
      const outcome = await runSiteBackups(env, { namespace, actor, via: surface }, now);
      if (!outcome.ok) return { ok: false, refusal: outcome.refusal };
      state.committed = outcome.runs.some((r) => r.ran);
      if (!state.committed)
        return {
          ok: false,
          refusal: outcome.runs.map((r) => (r.ran ? "" : r.refusal)).join(" "),
        };
      const unrecorded = outcome.runs.some((r) => r.ran && !r.recorded);
      state.summary = `${outcome.runs.map((r) => `${r.namespace}: ${r.ran ? r.line : `skipped, ${r.refusal}`}`).join(". ")}.${unrecorded ? " A call's audit row was not written (SITE_BACKUP_NOT_RECORDED in the log)." : ""}`;
      await auditClick(namespace ?? null, {
        sites: outcome.runs.map((r) => ({
          namespace: r.namespace,
          ran: r.ran,
          ok: r.ran ? r.call.ok : false,
        })),
      });
      return null;
    }
  }
}
