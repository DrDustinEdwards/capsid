import type { Env } from "./env";
import type { HealthSnapshot } from "./ops-types/sites";
import { probeFts } from "./store-probe";
import { aiSearchUsage } from "./doc-index";
import { HOUR_MS } from "./time";
import {
  durableObjectCheck,
  emailCheck,
  healthResponse,
  kvCheck,
  r2Check,
  type HealthCheck,
} from "@dustinedwards/site-runtime/health";
import { auditLogCheck } from "@dustinedwards/site-runtime/audit-log";
import { readTaskRuns, taskStates, TASKS } from "./task-runs";
import { WATCHER_CADENCE_MINUTES } from "./watcher";

import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
export const BACKUP_LAST_OK_KEY = "backup:last-ok";
export const BACKUP_STALE_HOURS = 26;

export async function backupFreshness(
  env: Env,
): Promise<{ last_ok: string | null; age_hours: number | null; warning?: string }> {
  let lastOk: string | null = null;
  try {
    lastOk = await env.APP_KV.get(BACKUP_LAST_OK_KEY);
  } catch {
    // The body is public (/health), so the driver's message stays out of it.
    return { last_ok: null, age_hours: null, warning: "backup freshness unreadable" };
  }
  if (!lastOk) return { last_ok: null, age_hours: null, warning: "no successful backup recorded" };
  const stamped = Date.parse(lastOk);
  // NaN compares false against the threshold, so without this an unreadable stamp would pass as
  // fresh with no warning.
  if (Number.isNaN(stamped)) {
    return {
      last_ok: lastOk,
      age_hours: null,
      warning: `${BACKUP_LAST_OK_KEY} is not a parseable time: ${lastOk.slice(0, 40)}`,
    };
  }
  const ageMs = Date.now() - stamped;
  const ageHours = Math.round((ageMs / HOUR_MS) * 10) / 10;
  const result: { last_ok: string; age_hours: number; warning?: string } = {
    last_ok: lastOk,
    age_hours: ageHours,
  };
  if (ageMs > BACKUP_STALE_HOURS * HOUR_MS) {
    result.warning = `last successful backup was ${ageHours}h ago, over the ${BACKUP_STALE_HOURS}h threshold`;
  }
  return result;
}

function probeError(err: unknown): string {
  return `error: ${errorMessage(err).slice(0, 120)}`;
}

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
  // Capsid's hybrid searches this month against its cap; null when KV cannot be read.
  ai_search?: { month: string; hybrid: number; cap: number } | null;
}

// The D1 ping and latest migration; d1 carries the driver's message, which publicState hides.
async function readStore(env: Env): Promise<{ d1: string; schema_version: string | null }> {
  let d1 = "unbound";
  try {
    const one = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    d1 = one?.ok === 1 ? "ok" : `unexpected: ${JSON.stringify(one)}`;
  } catch (err) {
    d1 = probeError(err);
  }
  if (d1 !== "ok") return { d1, schema_version: null };
  // Informational. A store without d1_migrations is null, not a health failure.
  const schema_version = await env.DB.prepare(
    "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
  )
    .first<{ name: string }>()
    .then((row) => row?.name ?? null)
    .catch(() => null);
  return { d1, schema_version };
}

function publicState(probe: string, state: string): string {
  if (!state.startsWith("error")) return state;
  logEvent(
    "HEALTH_PROBE_FAILED",
    { message: `HEALTH_PROBE_FAILED ${probe}: ${state}` },
    { level: "error" },
  );
  return "error";
}

export async function healthReport(env: Env): Promise<HealthReport> {
  const provenance = { sha: env.BUILD_SHA ?? "unknown" };
  const { d1, schema_version } = await readStore(env);
  const fts = d1 === "ok" ? await probeFts(env.DB) : "skipped";

  const backup = await backupFreshness(env);
  const bindings = await probeBindings(env);
  const ai_search = await aiSearchUsage(env).catch(() => null);

  const healthy = d1 === "ok" && fts === "ok";
  return {
    status: healthy ? "ok" : "degraded",
    ...provenance,
    schema_version,
    store: { d1, fts },
    bindings,
    backup,
    ai_search,
  };
}

// The runTask ledger as one warn check: a task whose newest run failed, or a periodic one gone
// quiet past two periods or never run. Tasks without a period count only on failure.
function taskCheck(env: Env, now: () => Date = () => new Date()): HealthCheck {
  return {
    name: "cron",
    level: "warn",
    run: async () => {
      const states = taskStates(await readTaskRuns(env.DB), now(), WATCHER_CADENCE_MINUTES);
      const periodic = new Set<string>(TASKS.filter((t) => t.period_ms !== null).map((t) => t.id));
      const flagged = states.filter(
        (t) =>
          t.flag === "failing" ||
          (periodic.has(t.id) && (t.flag === "quiet" || t.flag === "never")),
      );
      return (
        flagged.length === 0 || {
          ok: false,
          detail: flagged.map((t) => `${t.id} ${t.flag}`).join(", "),
        }
      );
    },
  };
}

// /health through site-runtime's healthResponse. The store is the fail level (D1 and the FTS probe),
// so a Worker bound to the wrong database is a 503.
export async function handleHealth(env: Env): Promise<Response> {
  const store = { d1: "unbound", fts: "skipped" };
  let schemaVersion: string | null = null;
  const checks: HealthCheck[] = [
    {
      name: "fts",
      run: async () => {
        store.fts = publicState("fts", await probeFts(env.DB));
        return store.fts === "ok" || { ok: false, detail: store.fts };
      },
    },
    taskCheck(env),
  ];
  if (env.MEDIA) checks.push({ ...r2Check("media", env.MEDIA), level: "warn" });
  if (env.AUDIT_BUCKET)
    checks.push({ ...r2Check("audit_bucket", env.AUDIT_BUCKET), level: "warn" });
  if (env.APP_KV) checks.push({ ...kvCheck("app_kv", env.APP_KV), level: "warn" });
  if (env.OAUTH_KV) checks.push({ ...kvCheck("oauth_kv", env.OAUTH_KV), level: "warn" });
  // Without RATE_LIMITER the limited routes refuse, and without TOOL_CALL_LOG a tool call goes
  // unlogged; the store still answers, so neither is a 503. AI_SEARCH is left out: every read of it
  // is billed, and search falls back to FTS5 without it.
  checks.push(
    durableObjectCheck("rate_limiter", env.RATE_LIMITER),
    durableObjectCheck("tool_call_log", env.TOOL_CALL_LOG),
  );
  // The send_email binding, warn: without it the digest and the push's email fallback are not sent.
  checks.push(emailCheck("email", env.EMAIL));
  // What is in the log, warn: a call started and never finished, a spike in calls, or rows not
  // copied to AUDIT_BUCKET for two days. Normal traffic is about 900 calls an hour.
  if (env.TOOL_CALL_LOG) checks.push(auditLogCheck(env, { spikePerHour: 3000 }));
  const response = await healthResponse({
    ping: async () => {
      const read = await readStore(env);
      store.d1 = publicState("d1", read.d1);
      schemaVersion = read.schema_version;
      return store.d1 === "ok" || { ok: false, detail: store.d1 };
    },
    backup: () => backupFreshness(env),
    backupTtlMs: 0,
    sha: env.BUILD_SHA ?? "unknown",
    checks,
  });
  const body = (await response.json()) as Record<string, unknown>;
  const provenance = {
    schema_version: schemaVersion,
    store,
  };
  return new Response(JSON.stringify({ ...body, ...provenance }), {
    status: response.status,
    headers: response.headers,
  });
}
