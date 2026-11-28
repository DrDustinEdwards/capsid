import type { Env } from "./env";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { pruneNotFound } from "@dustinedwards/site-runtime/not-found";
import { DAY_MS } from "./time";

const VERSION_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 365;
const DEPLOY_RETENTION_DAYS = 365;

function cutoffDay(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

// R2's bulk delete refuses more than 1000 keys rather than truncating, which would throw before backup:last-ok is stamped.
const R2_DELETE_MAX = 1000;

export async function deleteInChunks(bucket: R2Bucket, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
  }
  return keys.length;
}

// Prunes after the export so leaving rows are in today's dump. meta.changes is inflated by FTS5 triggers,
// so each DELETE is preceded by a COUNT over the same predicate in the same transaction.
export async function pruneD1(
  env: Env,
): Promise<{ versions: number; audit: number; deploys: number }> {
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
    // Appended last so the count/delete pairs above keep their counter positions.
    env.DB.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')"),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM deploy_outcomes WHERE run_at < datetime('now', ?1)",
    ).bind(`-${DEPLOY_RETENTION_DAYS} days`),
    env.DB.prepare("DELETE FROM deploy_outcomes WHERE run_at < datetime('now', ?1)").bind(
      `-${DEPLOY_RETENTION_DAYS} days`,
    ),
  ]);
  return {
    versions: pruned[0]?.results?.[0]?.n ?? 0,
    audit: pruned[2]?.results?.[0]?.n ?? 0,
    deploys: pruned[5]?.results?.[0]?.n ?? 0,
  };
}

// Pruned after the export; a failure is logged and never fails the run, the dump being marked.
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
