import type { Env } from "./env";
import type { HealthSnapshot } from "./ops-types/sites";
import { probeFts } from "./store-probe";
import { aiSearchUsage } from "./doc-index";
import { HOUR_MS } from "./time";
import { durableObjectCheck, healthResponse, kvCheck, r2Check, type HealthCheck } from "@dustinedwards/site-runtime/health";
import { auditLogCheck } from "@dustinedwards/site-runtime/audit-log";
import { readTaskRuns, taskStates, TASKS } from "./task-runs";
import { DEFAULT_CADENCE_MINUTES } from "./watcher";

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
  const ageHours = Math.round((ageMs / HOUR_MS) * 10) / 10;
  const result: { last_ok: string; age_hours: number; warning?: string } = { last_ok: lastOk, age_hours: ageHours };
  if (ageMs > BACKUP_STALE_HOURS * HOUR_MS) {
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

export interface HealthReport extends HealthSnapshot {
  // Capsid's own hybrid searches this month against its cap (design-hybrid-search 3.5).
  // Informational; null when KV cannot be read, absent from snapshots taken before it.
  ai_search?: { month: string; hybrid: number; cap: number } | null;
}

// /health serializes this and the watcher's pass records it for Capsid Portal, so the
// Portal shows the same values the live gate asserts.
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
  const ai_search = await aiSearchUsage(env).catch(() => null);

  // Status is the store only: the live gate polls it after a deploy, and a 503 fails it.
  const healthy = d1 === "ok" && fts === "ok";
  return { status: healthy ? "ok" : "degraded", ...provenance, schema_version, store: { d1, fts }, bindings, backup, ai_search };
}

/**
 * The runTask ledger as one warn check (src/task-runs.ts): a task whose newest run threw or
 * was refused, or a task with a period that has gone quiet past two periods or never ran,
 * the same flags the Portal's task list shows. Tasks without a period run with the work,
 * so only a failure counts for them. The detail names the tasks, never a reason (public).
 */
function taskCheck(env: Env, now: () => Date = () => new Date()): HealthCheck {
  return {
    name: "cron",
    level: "warn",
    run: async () => {
      const states = taskStates(await readTaskRuns(env.DB), now(), DEFAULT_CADENCE_MINUTES);
      const periodic = new Set<string>(TASKS.filter((t) => t.period_ms !== null).map((t) => t.id));
      const flagged = states.filter((t) => t.flag === "failing" || (periodic.has(t.id) && (t.flag === "quiet" || t.flag === "never")));
      return flagged.length === 0 || { ok: false, detail: flagged.map((t) => `${t.id} ${t.flag}`).join(", ") };
    },
  };
}

/**
 * /health in the family shape: site-runtime's healthResponse (status pass, warn or fail,
 * a check list, no-store, noindex), so the ops audit and every monitor read Capsid as they
 * read the other sites. The store is the fail level, as before: D1 and the FTS probe, so
 * a Worker bound to the wrong database is a 503. The backup, MEDIA, APP_KV, OAUTH_KV and the task
 * ledger warn. The fields the deploy gate and rollback read (sha, dirty, builtAt,
 * schema_version, store) are kept beside the family fields. The watcher still probes
 * itself in-process through healthReport.
 */
export async function handleHealth(env: Env): Promise<Response> {
  const store = { d1: "unbound", fts: "skipped" };
  let schemaVersion: string | null = null;
  const checks: HealthCheck[] = [
    {
      name: "fts",
      run: async () => {
        store.fts = await probeFts(env.DB);
        return store.fts === "ok" || { ok: false, detail: store.fts };
      },
    },
    taskCheck(env),
  ];
  if (env.MEDIA) checks.push({ ...r2Check("media", env.MEDIA), level: "warn" });
  if (env.APP_KV) checks.push({ ...kvCheck("app_kv", env.APP_KV), level: "warn" });
  if (env.OAUTH_KV) checks.push({ ...kvCheck("oauth_kv", env.OAUTH_KV), level: "warn" });
  // The two Durable Objects (area 8, H5), warn: a bound namespace mints an id, and no
  // object is woken. Without RATE_LIMITER the limited routes refuse, and without
  // TOOL_CALL_LOG a tool call goes unlogged; the store still answers, so neither is a 503.
  // Left out: AI_SEARCH, because every read of it is a billed query and the hybrid search
  // falls back to FTS5 without it; ASSETS, because the Portal's files are the deploy's own.
  checks.push(durableObjectCheck("rate_limiter", env.RATE_LIMITER), durableObjectCheck("tool_call_log", env.TOOL_CALL_LOG));
  // What is in the log (area 11, L8), warn: a call started and never finished, a spike in
  // calls, or rows not copied to AUDIT_BUCKET for two days.
  if (env.TOOL_CALL_LOG) checks.push(auditLogCheck(env));
  const response = await healthResponse({
    ping: async () => {
      try {
        const one = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
        store.d1 = one?.ok === 1 ? "ok" : `unexpected: ${JSON.stringify(one)}`;
      } catch (err) {
        store.d1 = probeError(err);
      }
      if (store.d1 !== "ok") return { ok: false, detail: store.d1 };
      // Informational. A store without d1_migrations is null, not a health failure.
      schemaVersion = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1")
        .first<{ name: string }>()
        .then((row) => row?.name ?? null)
        .catch(() => null);
      return true;
    },
    backup: () => backupFreshness(env),
    // A KV get, not an R2 listing, so there is nothing to save by holding it per isolate.
    backupTtlMs: 0,
    sha: env.BUILD_SHA ?? "unknown",
    checks,
  });
  const body = (await response.json()) as Record<string, unknown>;
  const provenance = { dirty: env.BUILD_DIRTY === "true", builtAt: env.BUILT_AT ?? null, schema_version: schemaVersion, store };
  return new Response(JSON.stringify({ ...body, ...provenance }), { status: response.status, headers: response.headers });
}
