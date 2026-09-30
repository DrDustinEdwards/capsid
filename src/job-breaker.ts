import type { Env } from "./env";
import { auditStatement } from "./store-guards";

// The queue's circuit breaker (job_9e602b31888f, OWASP ASI08, cascading failures).
//
// A namespace whose drivers failed N jobs in the last 24 hours stops handing out work
// until the seat or Dustin resets it. The breaker holds no "open" flag: it is computed
// at claim time from the audit log, so there is no state to drift from what happened,
// and nothing but a person's reset closes it. The reset is a timestamp; only failures
// after it count, so a reset cannot be undone by the failures that tripped it.
//
// What counts is the holder's own `fail` (audit `job-fail`). A seat's admin fail is a
// person cleaning up, and a claim that fails a tampered or corrupt body is the Worker
// refusing, not a driver failing, so neither trips it. Reverted improve attempts do not
// count either: a revert is the loop's normal answer to an experiment that did not help.

const BREAKER_THRESHOLD_DEFAULT = 3;
const BREAKER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BREAKER_THRESHOLD_KEY = "jobs:breaker:threshold";
export const breakerResetKey = (namespace: string) => `jobs:breaker:reset:${namespace}`;

export interface BreakerState {
  namespace: string;
  open: boolean;
  // Holder fails counted since `since`.
  failed: number;
  threshold: number;
  // The later of 24 hours ago and the last reset, as audit_log writes times.
  since: string;
  reset_at: string | null;
  // Why a setting could not be read, when one could not. The breaker then uses the
  // stricter value, so an outage never lets a failing namespace keep claiming.
  note?: string;
}

// audit_log.at is datetime('now'): "YYYY-MM-DD HH:MM:SS", UTC.
function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** The threshold, 1 to 50; the default when unset. An unreadable key uses the default and says so. */
async function readBreakerThreshold(kv: KVNamespace): Promise<{ threshold: number; note?: string }> {
  let raw: string | null;
  try {
    raw = await kv.get(BREAKER_THRESHOLD_KEY);
  } catch (err) {
    return { threshold: BREAKER_THRESHOLD_DEFAULT, note: `could not read ${BREAKER_THRESHOLD_KEY}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null) return { threshold: BREAKER_THRESHOLD_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    return { threshold: BREAKER_THRESHOLD_DEFAULT, note: `${BREAKER_THRESHOLD_KEY} holds ${JSON.stringify(raw)}, not a whole number from 1 to 50` };
  }
  return { threshold: n };
}

export async function breakerState(env: Env, namespace: string, now: Date): Promise<BreakerState> {
  const notes: string[] = [];
  const { threshold, note } = await readBreakerThreshold(env.APP_KV);
  if (note) notes.push(note);
  let resetAt: string | null = null;
  try {
    resetAt = await env.APP_KV.get(breakerResetKey(namespace));
  } catch (err) {
    // No reset read means every failure in the window counts: the stricter reading.
    notes.push(`could not read the reset for ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const windowStart = new Date(now.getTime() - BREAKER_WINDOW_MS);
  const reset = resetAt ? new Date(resetAt) : null;
  const from = reset && !Number.isNaN(reset.getTime()) && reset > windowStart ? reset : windowStart;
  if (resetAt && (!reset || Number.isNaN(reset.getTime()))) notes.push(`the reset for ${namespace} holds ${JSON.stringify(resetAt)}, not a time; ignored`);
  const since = sqlTime(from);
  // A transition writes two audit rows with this action, one for the job and one for
  // its mirror document, both on the job's path; counting paths counts each job once.
  const row = await env.DB.prepare("SELECT COUNT(DISTINCT path) AS n FROM audit_log WHERE action = 'job-fail' AND namespace = ?1 AND at >= ?2")
    .bind(namespace, since)
    .first<{ n: number }>();
  const failed = row?.n ?? 0;
  return {
    namespace,
    open: failed >= threshold,
    failed,
    threshold,
    since,
    reset_at: resetAt,
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

/** The refusal a claim returns while the breaker is open. */
export function breakerRefusal(state: BreakerState): string {
  return (
    `the circuit breaker for ${state.namespace} is open: ${state.failed} jobs failed by their holders since ${state.since} UTC, ` +
    `at or over the threshold of ${state.threshold}. Nothing in ${state.namespace} is handed out until the seat or Dustin resets it ` +
    `(improve_run action breaker_reset, or Reset breaker in the Portal).`
  );
}

/**
 * The seat's or Dustin's control (improve_run action breaker_reset, admin only, and the
 * Portal's reset_breaker): close one namespace's breaker, so failures before now stop
 * counting, and optionally set the threshold, which applies to every namespace. Audited
 * under the caller, and read back.
 */
export async function resetBreaker(
  env: Env,
  actor: string,
  now: Date,
  args: { namespace: string; threshold?: number }
): Promise<{ ok: true; action: "breaker_reset"; state: BreakerState } | { ok: false; error: string }> {
  if (args.threshold !== undefined && (!Number.isInteger(args.threshold) || args.threshold < 1 || args.threshold > 50)) {
    return { ok: false, error: "threshold must be a whole number from 1 to 50." };
  }
  const before = await breakerState(env, args.namespace, now);
  const stamp = now.toISOString();
  await env.APP_KV.put(breakerResetKey(args.namespace), stamp);
  if (args.threshold !== undefined) await env.APP_KV.put(BREAKER_THRESHOLD_KEY, String(args.threshold));
  await auditStatement(env.DB, actor, "job-breaker-reset", args.namespace, null, {
    reset_at: stamp,
    was_open: before.open,
    failed: before.failed,
    threshold: args.threshold ?? before.threshold,
  }).run();
  return { ok: true, action: "breaker_reset", state: await breakerState(env, args.namespace, now) };
}
