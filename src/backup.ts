import { COMPLETE_MARKER, dumpDatabase, writeCompleteMarker, type DumpResult } from "@dustinedwards/d1-dump";
import type { Env } from "./env";
import { BACKUP_LAST_OK_KEY } from "./health";
import { REPORT_PREFIX } from "./headers";
import { anchorKey, bestKey, BUDGET_KEY, META_LAST_KEY, MODE_KEY, pausedKey, ROSTER } from "./improve-schema";
import { readHoldoutManifests } from "./improve-scorer";
import { probeFts } from "./store-probe";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const PUT_CONCURRENCY = 20;

// KV lease is best-effort (no CAS). Export before prune. Dump TTL 90 days by age.
//
// The lease value carries a per-run token and a run releases only its own, so a run
// that outlived its TTL cannot delete the lease of the run that started after it. The
// TTL is an hour: above the 15-minute wall limit on a cron invocation, with room for
// an /ops/backup run, which has no wall limit. A lease left by an isolate that died
// mid-run then blocks backups for at most an hour of a daily schedule.
const LEASE_KEY = "backup:lease";
const LEASE_TTL_SECONDS = 3600;

const JSON_RETENTION_DAYS = 90;
// A floor under the age rule. If the cron stops for months every dump ages out,
// so the newest N survive regardless of age.
const JSON_MIN_KEPT = 14;
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

// Retention operates on the dump, never the object. A dump is a key prefix holding
// one object per table, so keys are grouped by run id (the segment after
// backups/json/), the newest JSON_MIN_KEPT complete runs are the floor, and an
// aged-out run is deleted whole. Counting objects instead of runs would shrink the
// floor to a fraction of the dumps it is meant to keep.
//
// A run id begins with its own ISO day, which is why the age test passes an empty
// prefix. A flat key with no slash is its own single-object run and ages out on the
// same rule.
function runIdOf(key: string): string {
  const rest = key.slice(JSON_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

// The dump itself is @dustinedwards/d1-dump, the package every site installs, so
// Capsid and the sites run one implementation (capsid/decisions.md, 2026-09-27,
// "shared functions across the sites", point 1).
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
// writes its own, and the rehearsal refuses a file that is not a migrations table.
const EXCLUDED = ["d1_migrations"];

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
  // a revoked agent keeps its row so the audit trail it wrote still resolves. A
  // rejected skill_edits row is what stops the optimizer proposing the same edit
  // again, and skill_failures is prose nothing else holds.
  "improve_scores",
  "improve_attempts",
  "improve_runs",
  "improve_skills",
  "jobs",
  "job_outcomes",
  "agents",
  "skill_evaluations",
  "skill_edits",
  "skill_failures",
  "job_outcome_prs",
  // The Portal's site configuration: edited by hand in the Portal, so the dump is
  // its only copy outside D1 besides the audit rows of each edit.
  "ops_sites",
  // The claims dataset (migrations/0023_job_claims.sql): what each agent said it did,
  // each check of that against GitHub, and every human touch. Append-only by trigger,
  // and nothing prunes them, so the dump is the only copy outside D1.
  "job_claims",
  "job_evaluations",
  "job_touches",
  // The watcher's memory of each finding across jobs (migrations/0024_watcher_findings.sql),
  // and what Claude Code sessions reported by hook and telemetry (0025): small, and
  // session_events is pruned at 30 days in code.
  "watcher_findings",
  "agent_sessions",
  "session_events",
  "session_usage",
  // The replay cache, pruned below: a jti matters only inside the signature window.
  "improve_jti",
] as const;

export interface BackupSummary {
  ran: true;
  json_prefix: string;
  json_keys: string[];
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
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
export interface BackupSkipped {
  ran: false;
  skipped: string;
}

export type BackupResult = BackupSummary | BackupSkipped;

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

export async function runBackup(env: Env): Promise<BackupResult> {
  const held = await env.APP_KV.get(LEASE_KEY);
  if (held !== null) {
    console.error(`BACKUP_LEASE_HELD another run holds ${LEASE_KEY} (started ${held}); this run pruned nothing`);
    return { ran: false, skipped: "lease-held" };
  }
  const now = new Date().toISOString();
  const lease = `${now} ${crypto.randomUUID()}`;
  await env.APP_KV.put(LEASE_KEY, lease, { expirationTtl: LEASE_TTL_SECONDS });
  try {
    return await exportAndPrune(env, now);
  } finally {
    // Release on success or throw, and only this run's own lease: if the TTL lapsed
    // and another run took the key, deleting it would let a third run start.
    const current = await env.APP_KV.get(LEASE_KEY);
    if (current === lease) await env.APP_KV.delete(LEASE_KEY);
    else console.error(`BACKUP_LEASE_LOST ${LEASE_KEY} is no longer this run's (now ${current}); left in place`);
  }
}

// The KV pins, by allowlist and never by prefix sweep. APP_KV also holds the GitHub
// installation-token cache, and a dump leaves the account, so a prefix sweep would
// mirror a live credential the first time someone added a key under a prefix nobody
// re-read. Every key below is a control value a human set, none a secret.
// backup:lease is absent: it is this run's own bookkeeping.
function kvPinKeys(): string[] {
  const keys = [MODE_KEY, BUDGET_KEY, META_LAST_KEY, BACKUP_LAST_OK_KEY];
  for (const namespace of ROSTER) keys.push(bestKey(namespace), pausedKey(namespace), anchorKey(namespace));
  return keys;
}

// null means the key was unset. An unreadable key is { unreadable: reason }, because
// restoring a null for it would clear a mode or a pause that existed.
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

// Writes one JSON object per table, _schema.json and the two sidecars under one run
// prefix, WITHOUT the completion marker, which exportAndPrune writes only once the
// preflight passes. Returns the documents rows as dumped, which the preflight and the
// markdown mirror both read, and any difference between the tables dumped and TABLES.
//
// The package reads every unpaged table in one D1 batch, which is one transaction, so
// every table describes the same instant and exported_at describes it. The restore
// rehearsal checks for the signature a torn read leaves.
//
// The two sidecars, underscore-prefixed so they cannot collide with a table name, are
// not in D1. Without them a restored improve loop has no mode, pins, pauses, best
// commits or holdout manifests, so every namespace scores as "no manifest" and every
// run refuses.
async function exportDump(env: Env, now: string): Promise<{ dump: DumpResult; docs: DocRow[]; tablesMismatch: string | null }> {
  const dump = await dumpDatabase(env.DB, env.MEDIA, {
    prefix: JSON_PREFIX,
    now: new Date(now),
    paged: PAGED,
    exclude: EXCLUDED,
    sidecars: {
      kv: { keys: await readKvPins(env) },
      "holdout-manifests": { manifests: await readHoldoutManifests(env) },
    },
    markComplete: false,
  });

  // Read back rather than kept from the snapshot: the package drops each table once it
  // is written. A documents object that cannot be read fails the run.
  const docsKey = dump.tables.find((t) => t.name === "documents")?.key;
  const docsObject = docsKey ? await env.MEDIA.get(docsKey) : null;
  if (!docsObject) throw new Error(`BACKUP_DOCUMENTS_UNREADABLE the dump at ${dump.prefix} has no readable documents object`);
  const docs = (JSON.parse(await docsObject.text()) as { rows: DocRow[] }).rows;

  // The package dumps what sqlite_master holds; TABLES is what the migrations create
  // (test/backup.test.ts). A difference means the live schema is not the one the
  // restore procedure knows, so the run is refused rather than marked complete.
  const dumped = new Set(dump.tables.map((t) => t.name));
  const listed = new Set<string>(TABLES);
  const missing = TABLES.filter((t) => !dumped.has(t));
  const extra = [...dumped].filter((t) => !listed.has(t));
  const tablesMismatch =
    missing.length || extra.length ? `tables-mismatch: missing ${missing.join(",") || "none"}; unlisted ${extra.join(",") || "none"}` : null;
  return { dump, docs, tablesMismatch };
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

// Deletes JSON dump runs past retention and above the floor, and CSP reports past
// retention.
async function pruneR2(env: Env, now: string): Promise<{ kept: number; pruned: number; reports: number }> {
  // Group objects into runs, newest run first, so the floor is runs and not objects.
  const runs = new Map<string, string[]>();
  for (const key of await listAllKeys(env.MEDIA, JSON_PREFIX)) {
    const id = runIdOf(key);
    const existing = runs.get(id);
    if (existing) existing.push(key);
    else runs.set(id, [key]);
  }
  const runIds = [...runs.keys()].sort().reverse();
  const dumpCutoff = cutoffDay(new Date(now), JSON_RETENTION_DAYS);
  // The floor is the newest JSON_MIN_KEPT counted runs. A marked run counts, and so
  // does an unmarked run older than the oldest marked one: it was written before
  // markers existed and the old rule counted it, so adding the marker prunes nothing
  // the old rule kept. A newer unmarked run is partial or refused; it holds no floor
  // slot and ages out on the 90-day rule like any run.
  const isMarked = (id: string) => (runs.get(id) ?? []).includes(`${JSON_PREFIX}${id}/${COMPLETE_MARKER}`);
  const oldestMarked = runIds.filter(isMarked).at(-1);
  const counted = runIds.filter((id) => isMarked(id) || oldestMarked === undefined || id < oldestMarked);
  const floor = new Set(counted.slice(0, JSON_MIN_KEPT));
  const staleRunIds = runIds.filter((id) => !floor.has(id) && isOlderThan(id, "", dumpCutoff));
  const staleDumpKeys = staleRunIds.flatMap((id) => runs.get(id) ?? []);
  if (staleDumpKeys.length > 0) await deleteInChunks(env.MEDIA, staleDumpKeys);

  const reportCutoff = cutoffDay(new Date(now), REPORT_RETENTION_DAYS);
  const staleReports = (await listAllKeys(env.MEDIA, REPORT_PREFIX)).filter((key) =>
    isOlderThan(key, REPORT_PREFIX, reportCutoff)
  );
  if (staleReports.length > 0) await deleteInChunks(env.MEDIA, staleReports);
  return { kept: runIds.length - staleRunIds.length, pruned: staleRunIds.length, reports: staleReports.length };
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

async function exportAndPrune(env: Env, now: string): Promise<BackupSummary> {
  const { dump, docs, tablesMismatch } = await exportDump(env, now);
  const jsonPrefix = dump.prefix;
  const jsonKeys = dump.keys;

  // A failed preflight refuses everything past this point as a unit: the marker, the
  // markdown write, the R2 prunes and the D1 deletes. A run that cannot trust its read
  // of documents cannot trust content derived from it. The JSON dumps above are kept:
  // an export deletes nothing, and an empty dump is the evidence of the day the store
  // looked empty.
  const checked = await preflight(env, docs);
  const fts = checked.fts;
  const pruneRefused = tablesMismatch ?? checked.pruneRefused;
  if (pruneRefused !== null) {
    console.error(
      `BACKUP_PREFLIGHT_REFUSED reason=${pruneRefused} documents=${docs.length} fts=${fts} ` +
        `dumps_written=${jsonKeys.length} prefix=${jsonPrefix}; nothing was written to or deleted from the mirror`
    );
    return {
      ran: true,
      json_prefix: jsonPrefix,
      json_keys: jsonKeys,
      documents: docs.length,
      markdown_written: 0,
      markdown_pruned: 0,
      json_backups_kept: 0,
      json_backups_pruned: 0,
      reports_pruned: 0,
      versions_pruned: 0,
      audit_pruned: 0,
      prune_refused: pruneRefused,
      preflight: { documents: docs.length, fts },
    };
  }

  // The completion marker, written after every object and only once the preflight
  // passed, so a run that threw or was refused carries none. Only a marked run counts
  // toward the retention floor. It lists the objects it vouches for, and the call adds
  // its own key to jsonKeys.
  await writeCompleteMarker(env.MEDIA, dump);

  const markdownPruned = await mirrorMarkdown(env, docs);
  const dumps = await pruneR2(env, now);
  const history = await pruneD1(env);

  // Stamp the last clean success, read by /health. A refused run returned above.
  await env.APP_KV.put(BACKUP_LAST_OK_KEY, now);

  return {
    ran: true,
    json_prefix: jsonPrefix,
    json_keys: jsonKeys,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: markdownPruned,
    json_backups_kept: dumps.kept,
    json_backups_pruned: dumps.pruned,
    reports_pruned: dumps.reports,
    versions_pruned: history.versions,
    audit_pruned: history.audit,
    prune_refused: null,
    preflight: { documents: docs.length, fts },
  };
}
