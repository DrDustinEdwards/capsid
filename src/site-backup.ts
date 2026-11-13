import type { Env } from "./env";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { backupFreshness } from "./health";
import { OFFACCOUNT_REPORT_KEY, isOffaccountSite, offaccountSiteOf } from "./offaccount";
import { readSiteConfig } from "./ops-sites";
import type { SiteOperator } from "./ops-types/sites";
import type { PortalBackups, SiteBackupRow, SiteBackupStatus } from "./ops-types/views";
import { callOperator, tokenSet, type FetchLike, type OperatorCall } from "./site-operator";
import { describeRuns } from "@dustinedwards/site-runtime/cron";
import { operatorRefusal, runCapsidJob } from "./site-jobs";
import { takeLimit } from "./site-repair";
import { auditStatement } from "./store-guards";
import { taskRunStatements } from "./task-runs";
import { parseDumpStamp, type OffaccountReport } from "./watcher-detect";

// BACKUPS FOR EVERY SITE, IN ONE PLACE (Dustin 2026-11-06, "as recommended"): checking the
// backups and backing up now are Capsid Admin's, not a tool on each site's own admin MCP.
// Each site keeps its nightly cron, which does the backing up; this reads what that cron
// left and runs its files passes on demand.
//
//   check  capsid_admin_read_ops action backups: every site that sets backup: true in its
//          operator configuration, its backup_status read live (the newest complete D1
//          dump and each files pass, with the site's own warning past 26 hours), beside
//          the Amazon copy's newest daily run from capsid-backups' last report. Capsid's
//          own dump is read from this Worker. Reads only, so it is not audited.
//   run    the site_backup control: run_job { backup: true } on one site, or on every such
//          site at once: the site's own jobs marked backup (its D1 dump and its files
//          passes), run now through the path its nightly cron runs (site-runtime
//          runJobTool), under the dump's own lease and checks, recorded in the site's
//          cron_runs. Each is safe to repeat: a dump adds a run, a files pass copies.
//          Each call that leaves the Worker is an audit_log row (site-backup) and a
//          task_runs row (site-backup), and the per-site rate limit is the repairs' one
//          (src/site-repair.ts): two minutes between calls of a tool on a site.
//
// Capsid never runs a site's work itself: it asks the site to run its own jobs. Capsid's own
// dump (CAPSID_DUMP below) is the one this Worker runs, under the same lease the nightly
// cron takes, so a run that overlaps the cron skips.

const BACKUP_AUDIT_ACTION = "site-backup";
/** The rate limit's key for back up now (src/site-repair.ts takeLimit): two minutes apart per site. */
export const BACKUP_LIMIT = "run_job:backup";

interface BackupSite {
  namespace: string;
  origin: string;
  operator: SiteOperator;
}

/** The sites whose operator configuration sets backup: true, in namespace order. */
export async function backupSites(
  env: Env,
  rows?: Awaited<ReturnType<typeof readSiteConfig>>,
): Promise<BackupSite[]> {
  return (rows ?? (await readSiteConfig(env.DB)))
    .filter(
      (r): r is typeof r & { origin: string; operator: SiteOperator } =>
        !!r.origin && !!r.operator?.backup,
    )
    .map((r) => ({ namespace: r.namespace, origin: r.origin, operator: r.operator }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}

async function amazonCopies(
  env: Env,
): Promise<{ received_at: string | null; sites: OffaccountReport["sites"] } | null> {
  try {
    const report = await env.APP_KV.get<OffaccountReport>(OFFACCOUNT_REPORT_KEY, "json");
    return report ? { received_at: report.received_at, sites: report.sites } : null;
  } catch {
    return null;
  }
}

/** Every site's backup state now, uncached. A site that cannot be read says why; the rest are still read. */
export async function readSiteBackups(
  env: Env,
  fetchImpl: FetchLike = fetch,
): Promise<PortalBackups> {
  const rows = await readSiteConfig(env.DB);
  const [sites, amazon, capsid] = await Promise.all([
    backupSites(env, rows),
    amazonCopies(env),
    backupFreshness(env),
  ]);
  const amazonFor = (namespace: string) => {
    // A further host (carrel-mcp) reports its site's copy (carrel): the copy is of the site's database.
    const site = offaccountSiteOf(namespace);
    const line = site ? amazon?.sites[site] : undefined;
    // The report names a run by its id; the answer gives its time, like every other field.
    return line
      ? {
          newest: line.newest ? (parseDumpStamp(line.newest)?.toISOString() ?? null) : null,
          bytes: line.bytes,
        }
      : null;
  };
  const read = await Promise.all(
    sites.map(async (site): Promise<SiteBackupRow> => {
      const call = await callOperator(env, site, "backup_status", fetchImpl, { backup: true });
      return {
        namespace: site.namespace,
        origin: site.origin,
        status:
          call.ok && call.data && typeof call.data === "object"
            ? (call.data as SiteBackupStatus)
            : null,
        error: call.error,
        amazon: amazonFor(site.namespace),
      };
    }),
  );
  // A site is checked when it or any further host of it (carrel-mcp for carrel) sets backup: true.
  const checked = new Set(sites.map((s) => offaccountSiteOf(s.namespace)));
  const unconfigured = rows
    .filter(
      (r) =>
        r.origin &&
        isOffaccountSite(r.namespace) &&
        r.namespace !== "capsid" &&
        !checked.has(r.namespace),
    )
    .map((r) => r.namespace);
  return {
    read_at: new Date().toISOString(),
    capsid: { status: capsid, amazon: amazonFor("capsid") },
    sites: read,
    amazon_report_at: amazon?.received_at ?? null,
    // Sites with an Amazon copy that Capsid cannot check or back up yet: no backup: true.
    not_configured: unconfigured,
  };
}

export type BackupRun =
  | { namespace: string; ran: false; refusal: string }
  | { namespace: string; ran: true; call: OperatorCall; line: string; recorded: boolean };

function backupLine(call: OperatorCall): string {
  return describeRuns("run_job { backup: true }", call);
}

/** Why backups cannot run on `namespace`, or null. Reads only, so the control's preview refuses what the run refuses. */
export function backupRefusal(env: Env, namespace: string): Promise<string | null> {
  return operatorRefusal(env, namespace, (operator) =>
    operator.backup
      ? null
      : `${namespace} does not set backup: true in its operator configuration.`,
  );
}

async function runOne(
  env: Env,
  site: BackupSite,
  args: { actor: string; via: string },
  now: Date,
  fetchImpl: FetchLike,
): Promise<BackupRun> {
  const wait = await takeLimit(env, site.namespace, BACKUP_LIMIT, now, false);
  if (wait)
    return {
      namespace: site.namespace,
      ran: false,
      refusal: `back up now on ${site.namespace} waits: ${wait}`,
    };
  const started = new Date();
  const call = await callOperator(env, site, "run_job", fetchImpl, {
    backup: true,
    args: { backup: true },
  });
  const line = backupLine(call);
  let recorded = true;
  try {
    await env.DB.batch([
      auditStatement(env.DB, args.actor, BACKUP_AUDIT_ACTION, site.namespace, null, {
        tool: "run_job",
        backup: true,
        via: args.via,
        status: call.status,
        ok: call.ok,
        error: call.error,
      }),
      ...taskRunStatements(
        env.DB,
        "site-backup",
        started,
        new Date(),
        call.ok ? "ok" : "refused",
        `${site.namespace}: ${line} (${args.via})`,
      ),
    ]);
  } catch (err) {
    recorded = false;
    logEvent(
      "SITE_BACKUP_NOT_RECORDED",
      {
        message: `SITE_BACKUP_NOT_RECORDED ${site.namespace}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
  return { namespace: site.namespace, ran: true, call, line, recorded };
}

/** Back up now: run_job { backup: true } on one site, or on every site that sets backup: true, at once. */
export async function runSiteBackups(
  env: Env,
  args: { namespace?: string; actor: string; via: string },
  now: Date,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; runs: BackupRun[] } | { ok: false; refusal: string }> {
  const all = await backupSites(env);
  if (args.namespace) {
    const refusal = await backupRefusal(env, args.namespace);
    if (refusal) return { ok: false, refusal };
  }
  const targets = args.namespace ? all.filter((s) => s.namespace === args.namespace) : all;
  if (targets.length === 0)
    return {
      ok: false,
      refusal:
        "no site sets backup: true in its operator configuration, so there is nothing to back up.",
    };
  const runs = await Promise.all(
    targets.map((site) =>
      tokenSet(env, site.operator)
        ? runOne(env, site, args, now, fetchImpl)
        : Promise.resolve<BackupRun>({
            namespace: site.namespace,
            ran: false,
            refusal: `the Capsid Worker secret ${site.operator.auth_var} is not set.`,
          }),
    ),
  );
  return { ok: true, runs };
}

/** The namespace that backs up Capsid's own D1 dump, by this Worker rather than through an operator API. */
export const CAPSID_DUMP = "capsid";

/**
 * Back up now for Capsid itself (Dustin 2026-11-06): the nightly cron's run, on demand. It
 * takes the cron's lease (src/backup.ts runBackup), so a run that overlaps the cron skips
 * and prunes nothing, and it writes the same task_runs row (backup) the Portal reads.
 */
export async function runCapsidDump(env: Env): Promise<{ ok: boolean; line: string }> {
  return runCapsidJob(env, "backup", false);
}
