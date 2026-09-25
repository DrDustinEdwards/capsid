import type { Env } from "./env";
import { probeFts } from "./store-probe";

export const BACKUP_LAST_OK_KEY = "backup:last-ok";
// Daily cron is 24h; 26h is that plus a 2h grace so one slow run does not warn.
export const BACKUP_STALE_HOURS = 26;

async function backupFreshness(
  env: Env
): Promise<{ last_ok: string | null; age_hours: number | null; warning?: string }> {
  let lastOk: string | null = null;
  try {
    lastOk = await env.APP_KV.get(BACKUP_LAST_OK_KEY);
  } catch (err) {
    return {
      last_ok: null,
      age_hours: null,
      warning: `backup freshness unreadable: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
    };
  }
  if (!lastOk) return { last_ok: null, age_hours: null, warning: "no successful backup recorded" };
  const stamped = Date.parse(lastOk);
  // NaN compares false against the threshold, so without this an unreadable stamp
  // would pass as fresh with no warning.
  if (Number.isNaN(stamped)) {
    return { last_ok: lastOk, age_hours: null, warning: `${BACKUP_LAST_OK_KEY} is not a parseable time: ${lastOk.slice(0, 40)}` };
  }
  const ageMs = Date.now() - stamped;
  const ageHours = Math.round((ageMs / 3_600_000) * 10) / 10;
  const result: { last_ok: string; age_hours: number; warning?: string } = { last_ok: lastOk, age_hours: ageHours };
  if (ageMs > BACKUP_STALE_HOURS * 3_600_000) {
    result.warning = `last successful backup was ${ageHours}h ago, over the ${BACKUP_STALE_HOURS}h threshold`;
  }
  return result;
}

function probeError(err: unknown): string {
  return `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
}

// The two bindings beside the store. Each probe reads a key that need not exist: a
// null answer proves the binding resolves. Reported as fields, left out of status.
async function probeBindings(env: Env): Promise<{ media: string; app_kv: string }> {
  let media = "unbound";
  if (env.MEDIA) {
    try {
      await env.MEDIA.head("health-probe");
      media = "ok";
    } catch (err) {
      media = probeError(err);
    }
  }
  let app_kv = "unbound";
  if (env.APP_KV) {
    try {
      await env.APP_KV.get("health-probe");
      app_kv = "ok";
    } catch (err) {
      app_kv = probeError(err);
    }
  }
  return { media, app_kv };
}

export interface HealthReport {
  status: "ok" | "degraded";
  sha: string;
  dirty: boolean;
  builtAt: string | null;
  schema_version: string | null;
  store: { d1: string; fts: string };
  bindings: { media: string; app_kv: string };
  backup: { last_ok: string | null; age_hours: number | null; warning?: string };
}

// /health serializes this and the console header renders it, so the console shows
// the same values the live gate asserts.
export async function healthReport(env: Env): Promise<HealthReport> {
  const provenance = {
    sha: env.BUILD_SHA ?? "unknown",
    dirty: env.BUILD_DIRTY === "true",
    builtAt: env.BUILT_AT ?? null,
  };

  let d1 = "unbound";
  let fts = "skipped";
  try {
    const one = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    d1 = one?.ok === 1 ? "ok" : `unexpected: ${JSON.stringify(one)}`;
  } catch (err) {
    d1 = `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
  if (d1 === "ok") fts = await probeFts(env.DB);

  // Informational. A store without d1_migrations is null, not a health failure.
  let schema_version: string | null = null;
  if (d1 === "ok") {
    try {
      const row = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
      schema_version = row?.name ?? null;
    } catch {
      schema_version = null;
    }
  }

  const backup = await backupFreshness(env);
  const bindings = await probeBindings(env);

  // Status is the store only: the live gate polls it after a deploy, and a 503 fails it.
  const healthy = d1 === "ok" && fts === "ok";
  return { status: healthy ? "ok" : "degraded", ...provenance, schema_version, store: { d1, fts }, bindings, backup };
}

export async function handleHealth(env: Env): Promise<Response> {
  const report = await healthReport(env);
  return Response.json(report, { status: report.status === "ok" ? 200 : 503 });
}
