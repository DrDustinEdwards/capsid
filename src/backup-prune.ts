import { listAllKeys } from "@dustinedwards/d1-dump";
import type { Env } from "./env";
import { REPORT_PREFIX } from "./security-headers";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { pruneNotFound } from "@dustinedwards/site-runtime/not-found";
import { DAY_MS } from "./time";

// The prunes of the nightly backup (src/backup.ts runs them after the export, under its lease).

// Retention for the history tables. Both are covered by the dump shelf life above.
const VERSION_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 365;

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

// R2's bulk delete takes at most 1000 keys per call and refuses the rest rather than
// truncating, so an unbounded array throws after the dumps are written and before
// backup:last-ok is stamped.
const R2_DELETE_MAX = 1000;

// One chunker for every prune, so a new delete site cannot be written unchunked
// beside the others.
export async function deleteInChunks(bucket: R2Bucket, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
  }
  return keys.length;
}

// Deletes CSP reports past retention (the sink no longer stores them; this
// reaps the last of them). The JSON dump runs outside the graduated retention (14 daily,
// 4 weekly and 3 monthly copies, DUMP_RETENTION above) are pruned by
// runCheckedBackup with d1-dump's default policy: it counts runs and not objects,
// deletes a run whole, never prunes the newest complete run, and deletes nothing while
// no complete run exists.
export async function pruneReports(env: Env, now: string): Promise<number> {
  const reportCutoff = cutoffDay(new Date(now), REPORT_RETENTION_DAYS);
  const staleReports = (await listAllKeys(env.MEDIA, REPORT_PREFIX)).filter((key) =>
    isOlderThan(key, REPORT_PREFIX, reportCutoff),
  );
  if (staleReports.length > 0) await deleteInChunks(env.MEDIA, staleReports);
  return staleReports.length;
}

// Prunes history after the export, so the rows leaving D1 are in today's dump.
// meta.changes is inflated by the FTS5 triggers, so each DELETE is preceded by a
// COUNT over the same predicate in the same transaction.
export async function pruneD1(env: Env): Promise<{ versions: number; audit: number }> {
  const pruned = await env.DB.batch<{ n: number }>([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_versions WHERE snapshot_at < datetime('now', ?1)",
    ).bind(`-${VERSION_RETENTION_DAYS} days`),
    env.DB.prepare("DELETE FROM document_versions WHERE snapshot_at < datetime('now', ?1)").bind(
      `-${VERSION_RETENTION_DAYS} days`,
    ),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE at < datetime('now', ?1)").bind(
      `-${AUDIT_RETENTION_DAYS} days`,
    ),
    env.DB.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?1)").bind(
      `-${AUDIT_RETENTION_DAYS} days`,
    ),
    // The replay cache, appended last so the count/delete pairs above keep the
    // positions their counters read. A jti matters only inside the signature window.
    env.DB.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')"),
  ]);
  return { versions: pruned[0]?.results?.[0]?.n ?? 0, audit: pruned[2]?.results?.[0]?.n ?? 0 };
}

// The 404 counts, the daily uptime rows and the ended Portal sessions, pruned after the export.
// A failure is logged and never fails the run: the dump is already marked.
export const DAILY_RETENTION_DAYS = 90;
export async function pruneDaily(env: Env, now: Date): Promise<void> {
  try {
    await pruneNotFound(env.DB, { days: DAILY_RETENTION_DAYS, now });
    await env.DB.prepare("DELETE FROM ops_uptime_daily WHERE day < ?1")
      .bind(cutoffDay(now, DAILY_RETENTION_DAYS - 1))
      .run();
    await env.DB.prepare("DELETE FROM portal_session_ends WHERE expires_at < ?1")
      .bind(now.getTime())
      .run();
  } catch (err) {
    logEvent(
      "BACKUP_DAILY_PRUNE_FAILED",
      { message: `BACKUP_DAILY_PRUNE_FAILED ${errorMessage(err)}` },
      { level: "error" },
    );
  }
}
