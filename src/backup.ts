import { BackupIncomplete, runCheckedBackup, type DumpResult } from "@dustinedwards/d1-dump";
import type { Env } from "./env";
import { BACKUP_LAST_OK_KEY } from "./health";
import { REPORT_PREFIX } from "./security-headers";
import { probeFts } from "./store-probe";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { pruneNotFound } from "@dustinedwards/site-runtime/not-found";
import { DAY_MS } from "./time";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const PUT_CONCURRENCY = 20;

// KV lease is best-effort (no CAS). Export before prune. Dump retention is d1-dump's graduated policy.
// Two runs can both read the key empty and both take it, so the run re-reads the lease
// after its export and refuses every destructive step unless the lease is still its own.
//
// The lease value carries a per-run token and a run releases only its own, so a run
// that outlived its TTL cannot delete the lease of the run that started after it. The
// TTL is an hour: above the 15-minute wall limit on a cron invocation, with room for
// an /ops/backup run, which has no wall limit. A lease left by an isolate that died
// mid-run then blocks backups for at most an hour of a daily schedule.
const LEASE_KEY = "backup:lease";
const LEASE_TTL_SECONDS = 3600;

// Retention for the history tables. Both are covered by the dump shelf life above.
const VERSION_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 180;

// CSP and COOP violation reports. Nothing else prunes this prefix, and a public
// unauthenticated path writes it.
const REPORT_RETENTION_DAYS = 30;

// Both prefixes carry an ISO date at a fixed offset, so the age test is a string
// comparison. A key with no parseable day is never pruned.
function isOlderThan(key: string, prefix: string, cutoffDay: string): boolean {
  const day = key.slice(prefix.length, prefix.length + 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < cutoffDay;
}

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

// The dump itself is @dustinedwards/d1-dump's runCheckedBackup, the nightly job every
// site runs, so Capsid and the sites run one implementation: dump without the marker,
// the standard checks (not empty, documents present, nothing excluded in the dump), the
// credential-column check, Capsid's own checks below, then the marker and the
// graduated prune. What stays here is Capsid's own: the lease, the KV sidecar, the
// tables-mismatch and preflight checks, the markdown mirror and the history prunes.
//
// Tables paged rather than read whole. Reading every table in one batch holds the
// whole database in the isolate, and once version bodies grew past what the isolate
// holds the cron died before its first put. A table qualifies only if it is
// append-only with an AUTOINCREMENT id, so the MAX(id) bound read inside the snapshot
// keeps the one-instant dump: rows at or below it cannot have changed, and only this
// run's own prune (after the export, under the lease) deletes them. documents and jobs
// are updated in place, so they stay in the batch. A version row can be a few hundred
// KB; an audit row carries no document body. A claim row can list 500 touched paths,
// so job_claims pages too; its two sibling tables carry no lists and stay in the batch.
const PAGED = {
  document_versions: { idColumn: "id", pageRows: 100 },
  audit_log: { idColumn: "id", pageRows: 1000 },
  job_claims: { idColumn: "id", pageRows: 200 },
};
// wrangler's migration ledger. A restore builds the schema from migrations/, which
// writes its own. The weekly drill builds its scratch database from _schema.json, and a
// run whose dumped tables differ from TABLES is refused as tables-mismatch.
//
// push_subscriptions (migrations/0041) is left out too (area 8, B8): each row is a
// device's push endpoint with its p256dh and auth keys, a credential that lets whoever
// holds it send to that device, and a dump leaves the account. _schema.json still
// carries its CREATE, so a restore has the table empty and each device subscribes again
// from the Portal.
export const EXCLUDED = ["d1_migrations", "push_subscriptions"] as const;

// The credential-column check (d1-dump `credentials`): these columns match its pattern
// by name and hold counts, not tokens.
export const CREDENTIAL_ALLOW: Record<string, string> = {
  "job_outcomes.tokens_input": "a model token count",
  "job_outcomes.tokens_output": "a model token count",
  "job_outcomes.tokens_cache_read": "a model token count",
  "job_outcomes.tokens_cache_creation": "a model token count",
  "bench_runs.input_tokens": "a model token count",
  "bench_runs.output_tokens": "a model token count",
  "bench_runs.cache_read_tokens": "a model token count",
  "bench_runs.cache_creation_tokens": "a model token count",
  // Not a column: words in a comment inside session_usage's CREATE (migrations/0025), which
  // d1-dump's columnNames splits on its commas without stripping comments first.
  "session_usage.claude_code.token.usage": "a metric name in a schema comment, not a column",
};

// Every real table in the schema. test/backup.test.ts derives this list from
// migrations/ and fails in both directions. Excluded: documents_fts and its
// documents_fts_* shadow tables, which the sync triggers rebuild from documents,
// and sqlite_sequence, which SQLite maintains for AUTOINCREMENT.
export const TABLES = [
  "documents",
  "namespaces",
  "document_versions",
  "audit_log",
  "document_links",
  // Nothing prunes the tables below except improve_jti, so a dump is the only copy
  // outside D1. job_outcomes and job_outcome_prs hold counts verified against pull
  // requests GitHub can delete. agents carries the sha256 verifier, never a key, and
  // a revoked agent keeps its row so the audit trail it wrote still resolves.
  "jobs",
  "job_outcomes",
  "agents",
  "job_outcome_prs",
  // The Portal's site configuration: edited by hand in the Portal, so the dump is
  // its only copy outside D1 besides the audit rows of each edit.
  "ops_sites",
  // The Portal's package configuration and its weekly GitHub numbers (migrations/0028):
  // the configuration is edited by hand, and the weekly rows are kept nowhere else.
  "ops_packages",
  "ops_package_weeks",
  // The claims dataset (migrations/0023_job_claims.sql): what each agent said it did,
  // each check of that against GitHub, and every human touch. Append-only by trigger,
  // and nothing prunes them, so the dump is the only copy outside D1.
  "job_claims",
  "job_evaluations",
  "job_touches",
  // The watcher's memory of each finding across jobs (migrations/0024_watcher_findings.sql),
  // and what Claude Code sessions reported by hook and telemetry (0025). session_events
  // holds a row per tool call since the tool events (docs/hooks.md), the largest table
  // here, and is pruned at 30 days in code.
  "watcher_findings",
  "agent_sessions",
  "session_events",
  "session_usage",
  // The run ledger (migrations/0029_task_runs.sql): each scheduled task's runs,
  // pruned at 14 days in code (src/task-runs.ts).
  "task_runs",
  // Each job's earlier versions, kept by capsid_work_jobs action "edit" (migrations/0033_job_versions.sql).
  // Nothing prunes it, and the job's row holds only the newest version.
  "job_versions",
  // Drivers' proposed changes to canon documents, pending or decided
  // (migrations/0034_canon_proposals.sql). Nothing prunes it: a decided row is the
  // record of who proposed and who approved a canon change.
  "canon_proposals",
  // The shared packages the Shared code view follows (migrations/0036_shared_packages.sql):
  // configuration, seeded by its migration, so a restore empties it before importing.
  "shared_packages",
  // The merge pipeline's approvals (migrations/0037_pr_approvals.sql): who approved which
  // pull request at which head, and how each approval ended. Nothing prunes it.
  "pr_approvals",
  // Revoked agents moved out of agents by the watcher pass (migrations/0038_agents_archive.sql).
  // Nothing prunes it: an archived row keeps a name reserved and a revoked key refused.
  "agents_archive",
  // What became of each deploy whose live gate ran (migrations/0039_deploy_outcomes.sql),
  // the evidence the promotion and demotion proposals read. Nothing prunes it.
  "deploy_outcomes",
  // The Access group pins of the retired Access sync (migrations/0040_access_sync_groups.sql;
  // the endpoint was removed 2026-10-31, Dustin). Empty; kept until a migration drops it.
  "access_sync_groups",
  // The methods paper's paired comparison (migrations/0047_bench.sql): the registered
  // tasks and every run's outcome, the data its primary outcome is computed from.
  // Insert-only and close-once by trigger; nothing prunes them.
  "bench_tasks",
  "bench_runs",
  // The registration and the drawn task order (migrations/0049_bench_draw.sql),
  // insert-only by trigger; nothing prunes them.
  "bench_registration",
  "bench_draw",
  // The replay cache, pruned below: a jti matters only inside the signature window.
  "improve_jti",
  // Capsid's own 404 counts (migrations/0053_page_404_daily.sql) and each site's daily
  // uptime (migrations/0054_ops_uptime_daily.sql), both pruned below at 90 days.
  "page_404_daily",
  "ops_uptime_daily",
  // The Portal sessions signed out or ended idle (migrations/0055_portal_session_ends.sql),
  // pruned below once their cookie could no longer be sent.
  "portal_session_ends",
] as const;

interface BackupSummary {
  ran: true;
  json_prefix: string;
  json_keys: string[];
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
  // Stale runs an R2 bucket lock refused to delete, left for a later prune (docs/backups.md).
  json_backups_locked: number;
  reports_pruned: number;
  versions_pruned: number;
  audit_pruned: number;
  // Null on a healthy run. Otherwise the named reason NOTHING was deleted. Read it
  // before believing a zero in any of the *_pruned counters.
  prune_refused: string | null;
  preflight: { documents: number; fts: string };
}

// A run that did not run. Named rather than thrown so the caller can tell a held
// lease from a failure.
interface BackupSkipped {
  ran: false;
  skipped: string;
}

export type BackupResult = BackupSummary | BackupSkipped;

// The HTTP status /ops/backup answers with, so "did nothing" is visible without the
// body: 409 when another run holds the lease, 503 when the preflight refused the prune
// (the dumps were written but nothing was marked, mirrored or pruned), 200 otherwise.
export function backupHttpStatus(result: BackupResult): number {
  if (!result.ran) return 409;
  return result.prune_refused === null ? 200 : 503;
}

// R2's bulk delete takes at most 1000 keys per call and refuses the rest rather than
// truncating, so an unbounded array throws after the dumps are written and before
// backup:last-ok is stamped.
const R2_DELETE_MAX = 1000;

// One chunker for every prune, so a new delete site cannot be written unchunked
// beside the others.
async function deleteInChunks(bucket: R2Bucket, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
  }
  return keys.length;
}

// R2 now and then refuses a put with "We encountered an internal error. Please try
// again. (10001)", and one refused put threw the whole run away: the 2026-10-27 and
// 2026-10-30 runs died on it, leaving the backup 38 hours old. Every put here writes a
// string under a fixed key, so trying it again is safe.
const PUT_ATTEMPTS = 3;
const PUT_RETRY_MS = 1000;

/** The bucket with its put tried up to PUT_ATTEMPTS times, waiting longer each time. */
function retryingPuts(bucket: R2Bucket, waitMs: number): R2Bucket {
  const put = async (...args: Parameters<R2Bucket["put"]>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await bucket.put(...args);
      } catch (err) {
        if (attempt >= PUT_ATTEMPTS) throw err;
        logEvent("BACKUP_PUT_RETRY", { message: `BACKUP_PUT_RETRY ${args[0]} attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}` });
        await new Promise((resolve) => setTimeout(resolve, waitMs * attempt));
      }
    }
  };
  return new Proxy(bucket, {
    get(target, prop) {
      if (prop === "put") return put;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function runBackup(env: Env, putRetryMs = PUT_RETRY_MS): Promise<BackupResult> {
  const held = await env.APP_KV.get(LEASE_KEY);
  if (held !== null) {
    logEvent("BACKUP_LEASE_HELD", { message: `BACKUP_LEASE_HELD another run holds ${LEASE_KEY} (started ${held}); this run pruned nothing` }, { level: "error" });
    return { ran: false, skipped: "lease-held" };
  }
  const now = new Date().toISOString();
  const lease = `${now} ${crypto.randomUUID()}`;
  await env.APP_KV.put(LEASE_KEY, lease, { expirationTtl: LEASE_TTL_SECONDS });
  try {
    return await exportAndPrune({ ...env, MEDIA: retryingPuts(env.MEDIA, putRetryMs) }, now, lease);
  } finally {
    // Release on success or throw, and only this run's own lease: if the TTL lapsed
    // and another run took the key, deleting it would let a third run start.
    const current = await env.APP_KV.get(LEASE_KEY);
    if (current === lease) await env.APP_KV.delete(LEASE_KEY);
    else logEvent("BACKUP_LEASE_LOST", { message: `BACKUP_LEASE_LOST ${LEASE_KEY} is no longer this run's (now ${current}); left in place` }, { level: "error" });
  }
}

// The KV pins, by allowlist and never by prefix sweep. APP_KV also holds the GitHub
// installation-token cache, and a dump leaves the account, so a prefix sweep would
// mirror a live credential the first time someone added a key under a prefix nobody
// re-read. Every key below is a control value, none a secret. backup:lease is absent:
// it is this run's own bookkeeping.
function kvPinKeys(): string[] {
  return [BACKUP_LAST_OK_KEY];
}

// null means the key was unset. An unreadable key is { unreadable: reason }, because
// restoring a null for it would clear a value that existed.
type KvPin = string | null | { unreadable: string };

async function readKvPins(env: Env): Promise<Record<string, KvPin>> {
  const pins: Record<string, KvPin> = {};
  for (const key of kvPinKeys()) {
    try {
      pins[key] = await env.APP_KV.get(key);
    } catch (err) {
      // Does not fail the run: the D1 dump must not be lost to a KV hiccup.
      pins[key] = { unreadable: err instanceof Error ? err.message : String(err) };
    }
  }
  return pins;
}

type DocRow = { namespace: string; path: string; body: string | null };

// The documents rows as dumped, which the preflight and the markdown mirror both read.
// Read back rather than kept from the snapshot: the package drops each table once it is
// written. A documents object that cannot be read fails the run.
async function dumpedDocs(env: Env, dump: DumpResult): Promise<DocRow[]> {
  const docsKey = dump.tables.find((t) => t.name === "documents")?.key;
  const docsObject = docsKey ? await env.MEDIA.get(docsKey) : null;
  if (!docsObject) throw new Error(`BACKUP_DOCUMENTS_UNREADABLE the dump at ${dump.prefix} has no readable documents object`);
  return (JSON.parse(await docsObject.text()) as { rows: DocRow[] }).rows;
}

// The package dumps what sqlite_master holds; TABLES is what the migrations create
// (test/backup.test.ts). A difference means the live schema is not the one the
// restore procedure knows, so the run is refused rather than marked complete.
function tablesMismatch(dump: DumpResult): string | null {
  const dumped = new Set(dump.tables.map((t) => t.name));
  const listed = new Set<string>(TABLES);
  const missing = TABLES.filter((t) => !dumped.has(t));
  const extra = [...dumped].filter((t) => !listed.has(t));
  return missing.length || extra.length ? `tables-mismatch: missing ${missing.join(",") || "none"}; unlisted ${extra.join(",") || "none"}` : null;
}

// The preflight, run before anything destructive. The dangerous case is a SELECT that
// succeeds and returns nothing: an empty documents table, or a binding resolved to
// an empty or different database, makes currentKeys empty, which marks every
// markdown object stale and deletes the mirror in one call.
//
// Two probes: a count above zero, and the same pinned FTS probe /health uses, which
// catches a binding pointed at a different database that has rows. Returns the named
// reason to refuse, or null.
async function preflight(env: Env, docs: DocRow[]): Promise<{ fts: string; pruneRefused: string | null }> {
  const fts = await probeFts(env.DB);
  const pruneRefused = docs.length === 0 ? "documents-empty" : fts === "ok" ? null : `fts-probe-failed: ${fts}`;
  return { fts, pruneRefused };
}

// Writes every document to the markdown mirror and deletes mirror objects no document
// backs. Returns how many were deleted.
async function mirrorMarkdown(env: Env, docs: DocRow[]): Promise<number> {
  const currentKeys = new Set<string>();
  for (let i = 0; i < docs.length; i += PUT_CONCURRENCY) {
    await Promise.all(
      docs.slice(i, i + PUT_CONCURRENCY).map((doc) => {
        const key = `${MARKDOWN_PREFIX}${doc.namespace}/${doc.path}`;
        currentKeys.add(key);
        return env.MEDIA.put(key, doc.body ?? "", { httpMetadata: { contentType: "text/markdown" } });
      })
    );
  }

  const existingMarkdown = await listAllKeys(env.MEDIA, MARKDOWN_PREFIX);
  const staleMarkdown = existingMarkdown.filter((key) => !currentKeys.has(key));
  if (staleMarkdown.length > 0) await deleteInChunks(env.MEDIA, staleMarkdown);
  return staleMarkdown.length;
}

// Deletes CSP reports past retention (the sink stopped storing them on 2026-10-20; this
// reaps the last of them). The JSON dump runs outside the graduated retention (14 daily,
// 8 weekly and 6 monthly copies, capsid/rulings/shared-homes-2026-10-06.md) are pruned by
// runCheckedBackup with d1-dump's default policy: it counts runs and not objects,
// deletes a run whole, never prunes the newest complete run, and deletes nothing while
// no complete run exists.
async function pruneReports(env: Env, now: string): Promise<number> {
  const reportCutoff = cutoffDay(new Date(now), REPORT_RETENTION_DAYS);
  const staleReports = (await listAllKeys(env.MEDIA, REPORT_PREFIX)).filter((key) =>
    isOlderThan(key, REPORT_PREFIX, reportCutoff)
  );
  if (staleReports.length > 0) await deleteInChunks(env.MEDIA, staleReports);
  return staleReports.length;
}

// Prunes history after the export, so the rows leaving D1 are in today's dump.
// meta.changes is inflated by the FTS5 triggers, so each DELETE is preceded by a
// COUNT over the same predicate in the same transaction.
async function pruneD1(env: Env): Promise<{ versions: number; audit: number }> {
  const pruned = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE snapshot_at < datetime('now', ?1)").bind(
      `-${VERSION_RETENTION_DAYS} days`
    ),
    env.DB.prepare("DELETE FROM document_versions WHERE snapshot_at < datetime('now', ?1)").bind(
      `-${VERSION_RETENTION_DAYS} days`
    ),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE at < datetime('now', ?1)").bind(
      `-${AUDIT_RETENTION_DAYS} days`
    ),
    env.DB.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?1)").bind(`-${AUDIT_RETENTION_DAYS} days`),
    // The replay cache, appended last so the count/delete pairs above keep the
    // positions their counters read. A jti matters only inside the signature window.
    env.DB.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')"),
  ]);
  return { versions: pruned[0]?.results?.[0]?.n ?? 0, audit: pruned[2]?.results?.[0]?.n ?? 0 };
}

// The run. runCheckedBackup writes one JSON object per table, _schema.json and the KV
// sidecar (underscore-prefixed so it cannot collide with a table name, holding the KV
// pins, which are not in D1) under one run prefix, then runs its checks and Capsid's.
// The package reads every unpaged table in one D1 batch, which is one transaction, so
// every table describes the same instant and exported_at describes it; the restore
// invariants script (scripts/dump-invariants.ts) checks for the signature a torn read
// leaves.
//
// Any failed check refuses everything destructive as a unit: the marker, the markdown
// write, the R2 prunes and the D1 deletes. A run that cannot trust its read of
// documents cannot trust content derived from it. The JSON dumps are kept: an export
// deletes nothing, and an empty dump is the evidence of the day the store looked empty.
// The 404 counts (site-runtime pruneNotFound) and the daily uptime rows, kept 90 days
// (area 8, N7 and U4), and the ended Portal sessions whose cookies have expired. After the export, like pruneD1, so the rows leaving D1 are in
// today's dump. A failure is logged and never fails the run: the dump is already marked.
export const DAILY_RETENTION_DAYS = 90;
async function pruneDaily(env: Env, now: Date): Promise<void> {
  try {
    await pruneNotFound(env.DB, { days: DAILY_RETENTION_DAYS, now });
    await env.DB.prepare("DELETE FROM ops_uptime_daily WHERE day < ?1").bind(cutoffDay(now, DAILY_RETENTION_DAYS - 1)).run();
    await env.DB.prepare("DELETE FROM portal_session_ends WHERE expires_at < ?1").bind(now.getTime()).run();
  } catch (err) {
    logEvent("BACKUP_DAILY_PRUNE_FAILED", { message: `BACKUP_DAILY_PRUNE_FAILED ${err instanceof Error ? err.message : String(err)}` }, { level: "error" });
  }
}

async function exportAndPrune(env: Env, now: string, lease: string): Promise<BackupSummary> {
  let docs: DocRow[] = [];
  let fts = "not-run";
  // Capsid's own reason, named so a log search finds it; the package's problems are
  // the reason only when Capsid's checks found none.
  let ownReason: string | null = null;

  let dump: DumpResult;
  let pruned = { kept: 0, pruned: 0, locked: 0 };
  let pruneRefused: string | null = null;
  try {
    const result = await runCheckedBackup(env.DB, env.MEDIA, {
      prefix: JSON_PREFIX,
      now: new Date(now),
      paged: PAGED,
      exclude: [...EXCLUDED],
      sidecars: { kv: { keys: await readKvPins(env) } },
      required: ["documents"],
      credentials: { allow: CREDENTIAL_ALLOW },
      check: async (d) => {
        docs = await dumpedDocs(env, d);
        const checked = await preflight(env, docs);
        fts = checked.fts;
        ownReason = tablesMismatch(d) ?? checked.pruneRefused;
        // The lease is get-then-put, so a run that started alongside this one may hold it
        // now. Re-read before anything destructive: a run that lost it prunes nothing.
        if (ownReason === null) {
          const holder = await env.APP_KV.get(LEASE_KEY);
          if (holder !== lease) ownReason = `lease-lost: ${LEASE_KEY} is now ${holder}`;
        }
        return ownReason === null ? [] : [ownReason];
      },
    });
    dump = result.dump;
    pruned = result.pruned;
  } catch (err) {
    if (!(err instanceof BackupIncomplete)) throw err;
    dump = err.dump;
    pruneRefused = ownReason ?? err.problems.join("; ");
  }
  const jsonPrefix = dump.prefix;
  const jsonKeys = dump.keys;

  if (pruneRefused !== null) {
    logEvent("BACKUP_PREFLIGHT_REFUSED", {
      message:
        `BACKUP_PREFLIGHT_REFUSED reason=${pruneRefused} documents=${docs.length} fts=${fts} ` +
        `dumps_written=${jsonKeys.length} prefix=${jsonPrefix}; nothing was written to or deleted from the mirror`,
    }, { level: "error" });
    return {
      ran: true,
      json_prefix: jsonPrefix,
      json_keys: jsonKeys,
      documents: docs.length,
      markdown_written: 0,
      markdown_pruned: 0,
      json_backups_kept: 0,
      json_backups_pruned: 0,
      json_backups_locked: 0,
      reports_pruned: 0,
      versions_pruned: 0,
      audit_pruned: 0,
      prune_refused: pruneRefused,
      preflight: { documents: docs.length, fts },
    };
  }

  // The package wrote the completion marker (it lists the objects it vouches for, and
  // adds its own key to jsonKeys) and pruned the dumps outside the graduated retention.
  const markdownPruned = await mirrorMarkdown(env, docs);
  const reports = await pruneReports(env, now);
  const history = await pruneD1(env);
  await pruneDaily(env, new Date(now));

  // Stamp the last clean success, read by /health. A refused run returned above.
  await env.APP_KV.put(BACKUP_LAST_OK_KEY, now);

  return {
    ran: true,
    json_prefix: jsonPrefix,
    json_keys: jsonKeys,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: markdownPruned,
    json_backups_kept: pruned.kept,
    json_backups_pruned: pruned.pruned,
    json_backups_locked: pruned.locked,
    reports_pruned: reports,
    versions_pruned: history.versions,
    audit_pruned: history.audit,
    prune_refused: null,
    preflight: { documents: docs.length, fts },
  };
}
