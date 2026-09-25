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
// Written last into a run's prefix by a run whose dump is complete and whose
// preflight passed. Underscore-prefixed like the sidecars.
const COMPLETE_MARKER = "_complete.json";
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

// Tables paged rather than read whole. Reading every table in one batch holds the
// whole database in the isolate, and once version bodies grew past what the isolate
// holds the cron died before its first put. These tables are read in pages bounded
// by a MAX(id) taken inside the snapshot batch and streamed to R2 as a multipart
// upload, so each object has the same {exported_at, table, rows} shape as every
// other table and a restore reads it the same way.
//
// A table qualifies only if it is append-only with an AUTOINCREMENT id, so the bound
// keeps the one-instant snapshot: rows at or below it cannot have changed, and only
// this run's own prune (after the export, under the lease) deletes them. documents
// and jobs are updated in place, so they stay in the batch.
//
// The value is the page size in rows. A version row can be a few hundred KB; an
// audit row carries no document body.
const PAGED_TABLES: ReadonlyMap<string, number> = new Map([
  ["document_versions", 100],
  ["audit_log", 1000],
]);
// R2 requires every part except the last to be the same size, and at least 5MiB.
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

// Writes {exported_at, table, rows} with the rows supplied a page at a time. The
// bytes are identical to JSON.stringify of the whole object, held at most one part
// and one page at a time.
async function putJsonStreamed(
  bucket: R2Bucket,
  key: string,
  head: string,
  pages: AsyncIterable<unknown[]>
): Promise<void> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/json" } });
  const parts: R2UploadedPart[] = [];
  const encoder = new TextEncoder();
  let part = new Uint8Array(MULTIPART_PART_BYTES);
  let filled = 0;
  const flush = async () => {
    parts.push(await upload.uploadPart(parts.length + 1, part.slice(0, filled)));
    part = new Uint8Array(MULTIPART_PART_BYTES);
    filled = 0;
  };
  const write = async (text: string) => {
    let bytes = encoder.encode(text);
    while (bytes.length > 0) {
      const n = Math.min(bytes.length, MULTIPART_PART_BYTES - filled);
      part.set(bytes.subarray(0, n), filled);
      filled += n;
      bytes = bytes.subarray(n);
      if (filled === MULTIPART_PART_BYTES) await flush();
    }
  };
  try {
    await write(head);
    let first = true;
    for await (const rows of pages) {
      for (const row of rows) {
        await write((first ? "" : ",") + JSON.stringify(row));
        first = false;
      }
    }
    await write("]}");
    if (filled > 0 || parts.length === 0) await flush();
    await upload.complete(parts);
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
}

async function* tablePages(db: D1Database, table: string, maxId: number, pageRows: number): AsyncGenerator<unknown[]> {
  let after = 0;
  while (after < maxId) {
    const { results } = await db
      .prepare(`SELECT * FROM ${table} WHERE id > ?1 AND id <= ?2 ORDER BY id LIMIT ?3`)
      .bind(after, maxId, pageRows)
      .all<{ id: number }>();
    if (results.length === 0) return;
    yield results;
    after = results[results.length - 1].id;
  }
}

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

async function exportAndPrune(env: Env, now: string): Promise<BackupSummary> {
  // One batch is one D1 transaction, so every table is read at the same instant and
  // exported_at describes it. Sequential reads are one instant per table: a write
  // landing between the documents read and the document_versions read puts a version
  // row in the dump whose document is not in it, and nothing downstream can tell. The
  // restore rehearsal checks for that signature.
  //
  // Cost: all row sets are live at once. Each result set is stringified, written and
  // dropped before the next, so at most one serialized copy is alive on top of the
  // row sets, and the largest tables are paged and streamed (PAGED_TABLES).
  const jsonPrefix = `${JSON_PREFIX}${now.replace(/[:.]/g, "-")}/`;
  const jsonKeys: string[] = [];
  const snapshot = await env.DB.batch(
    TABLES.map((table) =>
      env.DB.prepare(PAGED_TABLES.has(table) ? `SELECT MAX(id) AS max_id FROM ${table}` : `SELECT * FROM ${table}`)
    )
  );
  let docs: Array<{ namespace: string; path: string; body: string | null }> = [];
  const rowsPerTable: Array<unknown[] | null> = TABLES.map((_, i) => (snapshot[i]?.results ?? []) as unknown[]);
  for (let i = 0; i < TABLES.length; i++) {
    const table = TABLES[i];
    const results = rowsPerTable[i] ?? [];
    if (table === "documents") docs = results as typeof docs;
    const key = `${jsonPrefix}${table}.json`;
    const pageRows = PAGED_TABLES.get(table);
    if (pageRows !== undefined) {
      const maxId = Number((results[0] as { max_id: number | null } | undefined)?.max_id ?? 0);
      const head = `{"exported_at":${JSON.stringify(now)},"table":${JSON.stringify(table)},"rows":[`;
      await putJsonStreamed(env.MEDIA, key, head, tablePages(env.DB, table, maxId, pageRows));
    } else {
      await env.MEDIA.put(key, JSON.stringify({ exported_at: now, table, rows: results }), {
        httpMetadata: { contentType: "application/json" },
      });
    }
    jsonKeys.push(key);
    // documents is retained: the preflight and the markdown mirror both read it.
    if (table !== "documents") rowsPerTable[i] = null;
  }

  // The two sidecars, underscore-prefixed so they cannot collide with a table name and
  // the restore rehearsal can tell a sidecar from a table file without an exception
  // list. Neither is in D1. Without them a restored improve loop has no mode, pins,
  // pauses, best commits or holdout manifests, so every namespace scores as "no
  // manifest" and every run refuses.
  await env.MEDIA.put(`${jsonPrefix}_kv.json`, JSON.stringify({ exported_at: now, keys: await readKvPins(env) }), {
    httpMetadata: { contentType: "application/json" },
  });
  jsonKeys.push(`${jsonPrefix}_kv.json`);
  await env.MEDIA.put(
    `${jsonPrefix}_holdout-manifests.json`,
    JSON.stringify({ exported_at: now, manifests: await readHoldoutManifests(env) }),
    { httpMetadata: { contentType: "application/json" } }
  );
  jsonKeys.push(`${jsonPrefix}_holdout-manifests.json`);

  // Preflight before anything destructive. The dangerous case is a SELECT that
  // succeeds and returns nothing: an empty documents table, or a binding resolved to
  // an empty or different database, makes currentKeys empty, which marks every
  // markdown object stale and deletes the mirror in one call.
  //
  // Two probes: a count above zero, and the same pinned FTS probe /health uses, which
  // catches a binding pointed at a different database that has rows.
  //
  // A failure refuses everything past this point as a unit: the markdown write, the R2
  // prunes and the D1 deletes. A run that cannot trust its read of documents cannot
  // trust content derived from it. The JSON dumps above are kept: an export deletes
  // nothing, and an empty dump is the evidence of the day the store looked empty.
  const fts = await probeFts(env.DB);
  const pruneRefused = docs.length === 0 ? "documents-empty" : fts === "ok" ? null : `fts-probe-failed: ${fts}`;
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
  // toward the retention floor. It lists the objects it vouches for.
  const completeKey = `${jsonPrefix}${COMPLETE_MARKER}`;
  await env.MEDIA.put(completeKey, JSON.stringify({ exported_at: now, keys: jsonKeys }), {
    httpMetadata: { contentType: "application/json" },
  });
  jsonKeys.push(completeKey);

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

  // Prune history after the export, so the rows leaving D1 are in today's dump.
  // meta.changes is inflated by the FTS5 triggers, so each DELETE is preceded by a
  // COUNT over the same predicate in the same transaction.
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

  // Stamp the last clean success, read by /health. A refused run returned above.
  await env.APP_KV.put(BACKUP_LAST_OK_KEY, now);

  return {
    ran: true,
    json_prefix: jsonPrefix,
    json_keys: jsonKeys,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: staleMarkdown.length,
    json_backups_kept: runIds.length - staleRunIds.length,
    json_backups_pruned: staleRunIds.length,
    reports_pruned: staleReports.length,
    versions_pruned: pruned[0]?.results?.[0]?.n ?? 0,
    audit_pruned: pruned[2]?.results?.[0]?.n ?? 0,
    prune_refused: null,
    preflight: { documents: docs.length, fts },
  };
}
