import type { Env } from "./env";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { backupTaskResult, runBackup } from "./backup";
import { backupFreshness } from "./health";
import { OFFACCOUNT_REPORT_KEY, isOffaccountSite } from "./offaccount";
import { readSiteConfig, readSiteRow } from "./ops-sites";
import type { SiteOperator } from "./ops-types/sites";
import type { PortalBackups, SiteBackupRow, SiteBackupStatus } from "./ops-types/views";
import { callOperator, tokenSet, type FetchLike, type OperatorCall } from "./site-operator";
import { takeLimit } from "./site-repair";
import { auditStatement } from "./store-guards";
import { runTask, taskRunStatements } from "./task-runs";
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
//   run    the site_backup control: backup_media on one site, or on every such site at
//          once. Copy only (d1-dump backupFiles writes under files/ in the site's backups
//          bucket alone and never touches the source buckets), so it is safe to repeat.
//          Each call that leaves the Worker is an audit_log row (site-backup) and a
//          task_runs row (site-backup), and the per-site rate limit is the repairs' one
//          (src/site-repair.ts): two minutes between calls of a tool on a site.
//
// A site's D1 dump is not run here: each site's nightly cron runs it under its own lease and
// checks (d1-dump runCheckedBackup), and a second runner would race it. Capsid's own dump is
// the one exception (CAPSID_DUMP below): this Worker runs it, under the same lease the
// nightly cron takes, so a run that overlaps the cron skips.

const BACKUP_AUDIT_ACTION = "site-backup";

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
    const line = isOffaccountSite(namespace) ? amazon?.sites[namespace] : undefined;
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
  const unconfigured = rows
    .filter(
      (r) =>
        r.origin &&
        isOffaccountSite(r.namespace) &&
        r.namespace !== "capsid" &&
        !r.operator?.backup,
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
  if (!call.ok) return call.error ?? "backup_media failed";
  const files = (
    call.data as { files?: Array<{ name?: unknown; complete?: unknown; copied?: unknown }> } | null
  )?.files;
  if (!Array.isArray(files))
    return `backup_media answered ${call.status} without its files list, so nothing was proven`;
  const passes = files.map(
    (f) =>
      `${String(f.name)} ${f.complete === true ? "complete" : "goes on next run"}${typeof f.copied === "number" ? ` (${f.copied} copied)` : ""}`,
  );
  return `backup_media ran: ${passes.join(", ") || "no passes"}`;
}

/** Why backups cannot run on `namespace`, or null. Reads only, so the control's preview refuses what the run refuses. */
export async function backupRefusal(env: Env, namespace: string): Promise<string | null> {
  const row = await readSiteRow(env.DB, namespace);
  if (!row?.origin) return `${namespace} is not a configured site.`;
  if (!row.operator)
    return (
      row.operator_problem ??
      `${namespace} has no operator API configured, so Capsid may call nothing on it.`
    );
  if (!row.operator.backup)
    return `${namespace} does not set backup: true in its operator configuration.`;
  if (!tokenSet(env, row.operator))
    return `the Capsid Worker secret ${row.operator.auth_var} is not set, so nothing can be called on ${namespace}.`;
  return null;
}

async function runOne(
  env: Env,
  site: BackupSite,
  args: { actor: string; via: string },
  now: Date,
  fetchImpl: FetchLike,
): Promise<BackupRun> {
  const wait = await takeLimit(env, site.namespace, "backup_media", now, false);
  if (wait)
    return {
      namespace: site.namespace,
      ran: false,
      refusal: `backup_media on ${site.namespace} waits: ${wait}`,
    };
  const started = new Date();
  const call = await callOperator(env, site, "backup_media", fetchImpl, { backup: true });
  const line = backupLine(call);
  let recorded = true;
  try {
    await env.DB.batch([
      auditStatement(env.DB, args.actor, BACKUP_AUDIT_ACTION, site.namespace, null, {
        tool: "backup_media",
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
        message: `SITE_BACKUP_NOT_RECORDED ${site.namespace}: ${err instanceof Error ? err.message : String(err)}`,
      },
      { level: "error" },
    );
  }
  return { namespace: site.namespace, ran: true, call, line, recorded };
}

/** Back up now: backup_media on one site, or on every site that sets backup: true, at once. */
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
  let outcome = "";
  await runTask(
    env,
    "backup",
    () => runBackup(env),
    (result) => {
      const judged = backupTaskResult(result);
      outcome = judged ? `${judged.outcome}: ${judged.reason}` : "";
      return judged;
    },
    { tag: "BACKUP_NOW_THREW", rethrow: false },
  );
  // A throw is recorded by runTask and leaves outcome empty.
  return outcome.startsWith("ok:")
    ? { ok: true, line: `capsid: dump ${outcome}` }
    : {
        ok: false,
        line: `capsid: ${outcome || "the dump threw (see the backup row in task_runs)"}`,
      };
}
