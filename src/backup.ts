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
// The lease value carries a per-run token, and a run releases the lease only while
// the value is still its own, so a run that outlived its TTL cannot delete the lease
// of the run that started after it (audit finding F1-9, 2026-09-25). The TTL is an
// hour: above the 15-minute wall limit on a cron invocation, with room for an
// /ops/backup run, which has no wall limit. A lease left by an isolate that died
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

// CSP and COOP violation reports. 30 days, ruled 2026-08-13. Nothing else prunes
// this prefix, and it is written by a public unauthenticated path.
const REPORT_RETENTION_DAYS = 30;

// Both prefixes carry an ISO date at a fixed offset, so the age test is a string
// comparison. A key with no parseable day is never pruned.
function isOlderThan(key: string, prefix: string, cutoffDay: string): boolean {
  const day = key.slice(prefix.length, prefix.length + 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < cutoffDay;
}

// Retention operates on the dump, never on the object (audit 2, F33 light). A dump
// is a key PREFIX holding one object per table, so keys are grouped by run id (the
// segment after backups/json/), the newest JSON_MIN_KEPT complete RUNS are the floor
// (COMPLETE_MARKER), and an
// aged-out run is deleted whole. Counting objects would cut the floor to 2.8 dumps.
//
// A run id begins with its own ISO day, which is why the age test below passes an
// empty prefix. A flat key written before this change has no slash and is its own
// single-object run, so it ages out on the same rule.
function runIdOf(key: string): string {
  const rest = key.slice(JSON_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

// THE TABLES THAT ARE PAGED RATHER THAN READ WHOLE (2026-09-23, job_be450271dfa9;
// audit_log added 2026-09-25, audit finding F1-3).
//
// Reading every table in one batch held the whole database in the isolate. At 38.5MB
// on 2026-08-17 that fit; at 96.4MB on 2026-09-23, 66.5MB of it version bodies, it
// did not, and the cron died before its first put from 2026-09-20 on. These tables
// are read in pages, bounded by a MAX(id) taken inside the snapshot batch, and
// streamed to R2 as a multipart upload, so each object is the same
// {exported_at, table, rows} shape as every other table and a restore reads it the
// same way.
//
// A table qualifies ONLY if it is append-only with an AUTOINCREMENT id. Then the
// bound keeps the one-instant snapshot: a row above it was written after the batch,
// a row at or below it cannot have changed, and the only thing that deletes these
// rows is this run's own prune, which runs after the export and under the lease.
// documents and jobs are UPDATEd in place, so a page read after the batch would
// carry a state newer than the rest of the dump; they stay in the batch.
//
// The value is the page size in rows. The largest version row measured 2026-09-23
// was 238KB, so a version page is at most ~24MB. An audit row carries a short JSON
// params object and no document body.
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
  // The improve loop's four tables, added by migrations/0003_improve.sql. Nothing
  // prunes them, so a dump is the only copy of the lineage outside D1.
  "improve_scores",
  "improve_attempts",
  "improve_runs",
  "improve_skills",
  // The work queue (migrations/0006). Nothing prunes it either: a done job is the
  // record of who asked for what and what came back, and the mirrored document
  // carries only the body.
  "jobs",
  // What each finished job produced (migrations/0011). Nothing prunes it, and it is
  // the only place the verified counts live: the pull requests they were read from
  // can be deleted on GitHub, so a dump is the only copy of what was true when the
  // job ended.
  "job_outcomes",
  // The scoped credentials (migrations/0008). Nothing prunes it: a revoked agent
  // keeps its row so the audit trail it wrote still resolves to what it was allowed
  // to do. What the dump carries is the sha256 VERIFIER, never a key, exactly as
  // OPERATOR_KEY_HASH carries one; losing this table would orphan every minted
  // credential in the portfolio with no way to tell which was which.
  "agents",
  // The skill lifecycle's evidence (migrations/0012). Nothing prunes either: an
  // evaluation is what a status change was decided on, and a REJECTED edit is the
  // memory that stops the next optimizer proposing the same thing again. Losing
  // skill_edits would not lose a skill, it would lose every reason one was refused.
  "skill_evaluations",
  "skill_edits",
  // The failure notes (migrations/0013). Prose a driver wrote about a run that went
  // wrong, read by the next driver before it follows the same skill. Nothing prunes
  // it and nothing else holds it.
  "skill_failures",
  // Which pull requests an outcome counted (migrations/0015). The counts on the
  // outcome row are derived from these, and GitHub can delete a pull request, so a
  // dump is the only copy of what the merge state was verified against.
  "job_outcome_prs",
  // The replay cache (migrations/0004). Pruned below rather than retained: a jti
  // is only meaningful inside the 30-minute signature window.
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

// R2's bulk delete takes at most 1000 keys per call and REFUSES the 1001st rather
// than truncating. All three prunes used to hand it an unbounded array, so a large
// shed threw after the dumps were written and before backup:last-ok was stamped.
// Residual 5, closed 2026-09-08.
const R2_DELETE_MAX = 1000;

// One chunker for all three prunes, so a fourth delete site cannot be written
// unchunked beside three that are. Returns the count so callers count in one place.
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
    // Release on the way out, success or throw, so the TTL only has to cover an
    // isolate that died mid-run. Only this run's own lease is released: if the TTL
    // lapsed and another run took the key, deleting it would let a third run start
    // beside that one.
    const current = await env.APP_KV.get(LEASE_KEY);
    if (current === lease) await env.APP_KV.delete(LEASE_KEY);
    else console.error(`BACKUP_LEASE_LOST ${LEASE_KEY} is no longer this run's (now ${current}); left in place`);
  }
}

// THE KV PINS, BY ALLOWLIST AND NEVER BY PREFIX SWEEP.
//
// APP_KV also holds the GitHub installation-token cache, and a dump leaves the
// account, so a prefix sweep here would mirror a live credential the first time
// someone added a key under a prefix nobody re-read. Every key below is a control
// value a human set and none is a secret.
//
// backup:lease is absent: it is this run's own bookkeeping.
function kvPinKeys(): string[] {
  const keys = [MODE_KEY, BUDGET_KEY, META_LAST_KEY, BACKUP_LAST_OK_KEY];
  for (const namespace of ROSTER) keys.push(bestKey(namespace), pausedKey(namespace), anchorKey(namespace));
  return keys;
}

// null means the key was unset. A key that could not be read is recorded as
// { unreadable: reason } instead, because restoring a null for it would clear a mode
// or a pause that existed (audit finding F1-7, 2026-09-25).
type KvPin = string | null | { unreadable: string };

async function readKvPins(env: Env): Promise<Record<string, KvPin>> {
  const pins: Record<string, KvPin> = {};
  for (const key of kvPinKeys()) {
    try {
      pins[key] = await env.APP_KV.get(key);
    } catch (err) {
      // An unreadable key does not fail the run. The D1 dump is the half that must
      // not be lost to a KV hiccup.
      pins[key] = { unreadable: err instanceof Error ? err.message : String(err) };
    }
  }
  return pins;
}

async function exportAndPrune(env: Env, now: string): Promise<BackupSummary> {
  // ONE BATCH, ONE SNAPSHOT (residual 4, closed 2026-09-08).
  //
  // D1's batch is ONE TRANSACTION executed in order, so the reads (one per table in
  // TABLES) agree with each other and `exported_at` describes one instant. Sequential
  // reads were one instant per table: a write landing between the documents read and the document_versions
  // read put a version row in the dump whose document was not in it, and nothing
  // downstream could tell. The restore rehearsal checks for that signature.
  //
  // The cost is peak isolate memory: all row sets are live at once. Measured live
  // 2026-08-17, document_versions 25.8MB and documents 5.4MB on a 38.5MB database
  // against a 128MB isolate. Each result set is stringified, written, and dropped
  // before the next is touched, so at most one serialized copy is alive on top of
  // the row sets. It did push one over on 2026-09-20, and document_versions and
  // audit_log are now paged out of the batch and streamed (PAGED_TABLES, above).
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

  // THE TWO SIDECARS. Underscore-prefixed so they cannot collide with a table name
  // and the restore rehearsal can tell a sidecar from a table file without a
  // hardcoded exception list.
  //
  // Neither is in D1. A restore without them leaves the improve loop with no mode,
  // anchor pins, pause reasons, best commits or holdout manifests, so every
  // namespace scores as "no manifest" and every run refuses.
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

  // PREFLIGHT BEFORE ANYTHING DESTRUCTIVE (audit 2, F16).
  //
  // The dangerous case is a SELECT that SUCCEEDS AND RETURNS NOTHING. An empty
  // documents table, or a DB binding resolved by name to an empty or rebound
  // database, makes currentKeys empty, which marks every object under
  // backups/markdown/ stale and deletes the mirror in one call.
  //
  // Two probes: a count floor above zero, and the same pinned FTS probe /health
  // uses, which catches a binding pointed at a different database that has rows.
  //
  // A failure refuses everything past this point as a unit: the markdown WRITE, the
  // three R2 prunes and the two D1 deletes. A run that cannot trust its read of
  // documents cannot trust content derived from it, and the D1 deletes target the
  // same suspect database. The JSON dumps above are kept: an export deletes nothing
  // and an empty dump is the evidence of the day the store looked empty.
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

  // THE COMPLETION MARKER (audit finding F1-8, 2026-09-25). Written after every table
  // object and both sidecars, and only once the preflight passed, so a run that threw
  // mid-export and a refused run carry none. Only a marked run counts toward the
  // retention floor below. It lists the objects it vouches for.
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
  // The floor is the newest JSON_MIN_KEPT COUNTED runs. A marked run counts. An
  // unmarked run counts only if it sorts before the oldest marked run: it was written
  // before the marker existed, and the old rule counted it, so a deploy of the marker
  // prunes nothing the old rule kept. An unmarked run newer than that is partial or
  // refused; it holds no floor slot and ages out on the 90-day rule like any run.
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

  // Prune history AFTER the export above, so the rows leaving D1 are in today's dump.
  //
  // COUNTED, NOT REPORTED (audit 2, F37). meta.changes is inflated by the FTS5
  // triggers, so each DELETE is preceded by a COUNT over the identical predicate.
  // Both pairs are in one batch, one transaction in order, so the count is of exactly
  // the rows the next statement removes.
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
    // The replay cache, appended LAST so the two count/delete pairs above keep the
    // positions their counters read. A jti is meaningful only inside the 30-minute
    // signature window.
    env.DB.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')"),
  ]);

  // Stamp the last CLEAN success. Read by /health, which warns past a day. A
  // preflight-refused run returned above without stamping.
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
