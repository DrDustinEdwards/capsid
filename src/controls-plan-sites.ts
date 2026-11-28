import { revisionOf } from "./controls-base";
import { namespaceNameRefusal } from "./namespace-admin";
import { CARREL_SCRIPT, SITE_SECRET, siteKeyTarget } from "./site-key";
import { type Plan, refused, shown } from "./controls-plan-base";
import type { Env } from "./env";
import { validatePackage, readPackageRow, describePackage } from "./ops-package-config";
import {
  validateSite,
  readSiteRow,
  describeSite,
  originMoveRefusal,
  type SiteInput,
} from "./ops-sites";
import { toolRefusal, tokenSet } from "./site-operator";
import { limitRefusalFor } from "./site-repair";
import {
  BACKUP_LIMIT,
  backupRefusal,
  backupSites,
  CAPSID_DUMP,
  NO_BACKUP_SITES,
} from "./site-backup";
import { CAPSID_NAMESPACE, jobRefusal } from "./site-jobs";

const SITE_FIELDS = ["name", "origin", "health_path", "platform", "script"] as const;

export async function planSiteAction(
  env: Env,
  action:
    | "site_key_rotate"
    | "site_add"
    | "site_edit"
    | "site_remove"
    | "package_add"
    | "package_edit"
    | "package_remove"
    | "site_repair"
    | "site_backup"
    | "run_job",
  p: Record<string, string>,
  actor: string,
  click: string,
): Promise<Plan> {
  switch (action) {
    case "site_key_rotate": {
      const bad = namespaceNameRefusal(p.namespace);
      if (bad) return refused(bad);
      const target = await siteKeyTarget(env, p.namespace);
      if (!target.ok) return refused(target.refusal);
      return {
        ok: true,
        changes: [
          `Mint a new key and set it as ${SITE_SECRET} on the Worker ${target.siteScript}, then as ${target.carrelSecret} on ${CARREL_SCRIPT}, through the Cloudflare API.`,
          "The value is never shown, logged or written to an audit row: the row names each side's script and secret and whether it was set.",
          `If ${target.siteScript} refuses it, nothing changes and Carrel is not touched. If Carrel alone refuses it, the two sides differ and Carrel's calls to the site are refused until you rotate again.`,
        ],
        audit: [`set_site_key by ${actor}`, click],
      };
    }
    case "site_add": {
      const checked = validateSite(p);
      if (!checked.ok) return refused(checked.refusal);
      const site = checked.site;
      // A registered namespace, or a further host of one (`<namespace>-<host>`, such as carrel-mcp): the
      // rule the watcher's site-map check reads (ops-sites owningNamespace). Namespace names hold no
      // LIKE wildcards (lowercase letters, digits and hyphens).
      const registered = await env.DB.prepare(
        "SELECT namespace FROM namespaces WHERE namespace = ?1 OR ?1 LIKE namespace || '-%' LIMIT 1",
      )
        .bind(site.namespace)
        .first<{ namespace: string }>();
      if (!registered)
        return refused(
          `'${site.namespace}' is neither a registered namespace nor a further host of one (<namespace>-<host>). Register it first; a site row for an unregistered namespace is drift the watcher reports.`,
        );
      const existing = await readSiteRow(env.DB, site.namespace);
      if (existing)
        return refused(
          `${site.namespace} already has a row (${describeSite(existing)}). Edit it instead.`,
        );
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
      if (before.revision !== revision)
        return refused(
          `${site.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`,
        );
      const diffs = SITE_FIELDS.filter((f) => before[f] !== site[f]).map(
        (f) => `${f}: ${shown(before[f])} -> ${shown(site[f])}`,
      );
      const beforeOperator = before.operator ? JSON.stringify(before.operator) : null;
      if (site.operator !== undefined && site.operator !== beforeOperator)
        diffs.push(`operator: ${shown(beforeOperator)} -> ${shown(site.operator)}`);
      if (diffs.length === 0) return refused(`the edit changes nothing in ${site.namespace}.`);
      const moved = originMoveRefusal(before, site);
      if (moved) return refused(moved);
      const changes = [
        `ops_sites ${site.namespace}, revision ${revision} -> ${revision + 1}:`,
        ...diffs.map((d) => `  ${d}`),
      ];
      if (before.self_probe && before.origin !== site.origin)
        changes.push(
          "The origin changes, so the in-process self-probe is cleared and the site is probed over HTTP.",
        );
      return { ok: true, changes, audit: [`ops-site-edited by ${actor}`, click] };
    }
    case "site_remove": {
      const revision = revisionOf(p.revision);
      if (!p.namespace || revision === null)
        return refused("site_remove needs a namespace and the revision of the row it removes.");
      const before = await readSiteRow(env.DB, p.namespace);
      if (!before) return refused(`${p.namespace} has no row to remove.`);
      if (before.revision !== revision)
        return refused(
          `${p.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`,
        );
      const registered = await env.DB.prepare(
        "SELECT namespace FROM namespaces WHERE namespace = ?1",
      )
        .bind(p.namespace)
        .first<{ namespace: string }>();
      return {
        ok: true,
        changes: [
          `ops_sites: remove ${p.namespace} (${describeSite(before)}). The row is kept in the audit row.`,
          before.origin
            ? `The watcher stops probing ${before.origin}, and its uptime ring leaves the next pass.`
            : `Nothing was probed for it.`,
          ...(registered
            ? [
                `${p.namespace} is still registered, so the site-map check reports it as unmapped until it has a row again.`,
              ]
            : []),
        ],
        audit: [`ops-site-removed by ${actor}`, click],
      };
    }
    case "package_add": {
      const checked = validatePackage(p);
      if (!checked.ok) return refused(checked.refusal);
      const existing = await readPackageRow(env.DB, checked.pkg.name);
      if (existing)
        return refused(
          `${checked.pkg.name} is already configured (${describePackage(existing)}). Edit it instead.`,
        );
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
      if (before.revision !== revision)
        return refused(
          `${checked.pkg.name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`,
        );
      const diffs = (["repo", "formerly"] as const)
        .filter((k) => before[k] !== checked.pkg[k])
        .map((k) => `  ${k}: ${shown(before[k])} -> ${shown(checked.pkg[k])}`);
      if (diffs.length === 0) return refused(`the edit changes nothing in ${checked.pkg.name}.`);
      return {
        ok: true,
        changes: [
          `ops_packages ${checked.pkg.name}, revision ${revision} -> ${revision + 1}:`,
          ...diffs,
        ],
        audit: [`ops-package-edited by ${actor}`, click],
      };
    }
    case "package_remove": {
      const revision = revisionOf(p.revision);
      if (!p.name || revision === null)
        return refused("package_remove needs a name and the revision of the row it removes.");
      const before = await readPackageRow(env.DB, p.name);
      if (!before) return refused(`${p.name} is not configured.`);
      if (before.revision !== revision)
        return refused(
          `${p.name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`,
        );
      return {
        ok: true,
        changes: [
          `ops_packages: remove ${describePackage(before)}. The row is kept in the audit row, and its weekly GitHub rows stay.`,
        ],
        audit: [`ops-package-removed by ${actor}`, click],
      };
    }
    case "site_repair": {
      if (!p.namespace || !p.tool) return refused("site_repair needs a namespace and a tool.");
      const row = await readSiteRow(env.DB, p.namespace);
      if (!row?.origin) return refused(`${p.namespace} is not a configured site.`);
      if (!row.operator)
        return refused(
          row.operator_problem ??
            `${p.namespace} has no operator API configured, so Capsid may call nothing on it.`,
        );
      const bad = toolRefusal(row.operator, p.tool);
      if (bad) return refused(bad);
      if (!tokenSet(env, row.operator))
        return refused(
          `the Capsid Worker secret ${row.operator.auth_var} is not set, so nothing can be called on ${p.namespace}.`,
        );
      const wait = await limitRefusalFor(env, p.namespace, p.tool, new Date());
      if (wait) return refused(`${p.tool} on ${p.namespace} waits: ${wait}`);
      return {
        ok: true,
        changes: [
          `POST ${row.origin}${row.operator.path} with tool ${p.tool}, authorized by the Capsid Worker secret ${row.operator.auth_var} (the token is never shown or recorded).`,
          `The site re-derives that store from its source and reports a read-back verdict; the result is shown when it returns, up to five minutes. One task_runs row (site-repair) records it.`,
        ],
        audit: [`site-repair by ${actor}`, click],
      };
    }
    case "site_backup": {
      const now = new Date();
      if (p.namespace === CAPSID_DUMP)
        return {
          ok: true,
          changes: [
            "capsid: run Capsid's own D1 dump within five minutes, on the next tick, the same run as the nightly 09:00 UTC cron (d1-dump runCheckedBackup into the backups bucket, then its checks and prunes). It waits for the cron's lease, so it never overlaps a run. One task_runs row (backup) records it.",
          ],
          audit: [`site-backup by ${actor}`, click],
        };
      if (p.namespace) {
        const bad = await backupRefusal(env, p.namespace);
        if (bad) return refused(bad);
      }
      const sites = (await backupSites(env)).filter(
        (s) => !p.namespace || s.namespace === p.namespace,
      );
      if (sites.length === 0) return refused(NO_BACKUP_SITES);
      const lines = await Promise.all(
        sites.map(async (s) => {
          const wait = await limitRefusalFor(env, s.namespace, BACKUP_LIMIT, now);
          const unset = tokenSet(env, s.operator)
            ? null
            : `the Capsid Worker secret ${s.operator.auth_var} is not set`;
          return `${s.namespace}: POST ${s.origin}${s.operator.path} with tool run_job { backup: true }, authorized by ${s.operator.auth_var}${unset || wait ? `; skipped, ${unset ?? `it waits: ${wait}`}` : ""}.`;
        }),
      );
      return {
        ok: true,
        changes: [
          ...lines,
          "Each site runs its own backup jobs now (its D1 dump and its files passes), through the path its nightly cron runs, recorded in its cron_runs. A dump adds a run under the site's own checks; a files pass copies under files/ in its backups bucket and goes on where it stopped. The result is shown when every site answers, up to five minutes. Each call is an audit_log and a task_runs row (site-backup). The tokens are never shown or recorded.",
        ],
        audit: [`site-backup by ${actor}`, click],
      };
    }
    case "run_job": {
      if (!p.namespace || !p.name) return refused("run_job needs a namespace and a job name.");
      const bad = await jobRefusal(env, p.namespace, p.name);
      if (bad) return refused(bad);
      if (p.namespace === CAPSID_NAMESPACE)
        return {
          ok: true,
          changes: [
            `capsid: run Capsid's own ${p.name} job within five minutes, on the next tick, the same run as the nightly 09:00 UTC cron, with its task_runs row (${p.name}). The dump waits for the cron's lease, so it never overlaps a run.`,
          ],
          audit: [`site-job by ${actor}`, click],
        };
      const row = await readSiteRow(env.DB, p.namespace);
      const wait = await limitRefusalFor(env, p.namespace, `run_job:${p.name}`, new Date());
      if (wait) return refused(`${p.name} on ${p.namespace} waits: ${wait}`);
      return {
        ok: true,
        changes: [
          `POST ${row?.origin ?? ""}${row?.operator?.path ?? ""} with tool run_job { job: "${p.name}" }, authorized by the Capsid Worker secret ${row?.operator?.auth_var ?? ""} (the token is never shown or recorded).`,
          "The site runs that job now through the code its cron runs (site-runtime runJobTool), recorded in its cron_runs so /health's cron check sees the run, and answers each run's outcome; the result is shown when it returns, up to five minutes. A name the site does not run is refused by the site, naming its jobs. One audit_log and one task_runs row (site-job) record it.",
        ],
        audit: [`site-job by ${actor}`, click],
      };
    }
  }
}
