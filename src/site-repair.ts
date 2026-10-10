import type { Env } from "./env";
import { logEvent } from "./log";
import { readSiteRow } from "./ops-sites";
import type { SiteOperator } from "./ops-types";
import { callLine, callOperator, toolRefusal, type FetchLike, type OperatorCall } from "./site-operator";
import { auditStatement } from "./store-guards";
import { taskRunStatements } from "./task-runs";

// ONE REPAIR, from the Portal, the controls tool or the watcher (job_09e5f6cbf782). The
// site_repair control and the watcher's repair step both come here, so the allowlist, the
// rate limit and the record are one implementation: an audit_log row (site-repair) and a
// task_runs row (site-repair) for every call that left the Worker, and none for one
// refused before it.
//
// The rate limit is per site and tool, in APP_KV, so a stuck check cannot loop:
//   - any call waits MIN_GAP_MS after the last one, whoever made it (a double click, or the
//     watcher and a person at once);
//   - the watcher makes at most AUTO_PER_DAY calls per site and tool in a rolling day, and
//     after that only a person can run it. The finding says so.

export const REPAIR_AUDIT_ACTION = "site-repair";
const LIMIT_PREFIX = "site-repair-limit:";
const MIN_GAP_MS = 2 * 60_000;
const AUTO_GAP_MS = 30 * 60_000;
export const AUTO_PER_DAY = 4;
const DAY_MS = 86_400_000;

interface LimitRecord {
  last: string;
  auto: string[];
}

const limitKey = (namespace: string, tool: string) => `${LIMIT_PREFIX}${namespace}:${tool}`;

async function readLimit(env: Pick<Env, "APP_KV">, namespace: string, tool: string): Promise<LimitRecord | null> {
  const raw = await env.APP_KV.get(limitKey(namespace, tool));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LimitRecord;
    return typeof parsed.last === "string" && Array.isArray(parsed.auto) ? parsed : null;
  } catch {
    // A record that does not parse is replaced by the next call's; it limits nothing until
    // then, and that is logged so it is not silent.
    logEvent("warn", "SITE_REPAIR_LIMIT_UNREADABLE", { message: `SITE_REPAIR_LIMIT_UNREADABLE ${namespace} ${tool}` });
    return null;
  }
}

/** Why this call must wait, or null. `auto` is the watcher. */
export function limitRefusal(record: LimitRecord | null, now: Date, auto: boolean): string | null {
  if (!record) return null;
  const since = now.getTime() - Date.parse(record.last);
  const gap = auto ? AUTO_GAP_MS : MIN_GAP_MS;
  if (since < gap) return `it ran ${Math.round(since / 60_000)} minute(s) ago; the next call may go after ${Math.round(gap / 60_000)} minutes.`;
  if (auto) {
    const today = record.auto.filter((at) => now.getTime() - Date.parse(at) < DAY_MS);
    if (today.length >= AUTO_PER_DAY) return `the watcher has run it ${today.length} times in the last day, its limit; a person can still run it from the Portal.`;
  }
  return null;
}

/** The rate limit for a person's call, read now: what a preview shows. */
export async function limitRefusalFor(env: Pick<Env, "APP_KV">, namespace: string, tool: string, now: Date): Promise<string | null> {
  return limitRefusal(await readLimit(env, namespace, tool), now, false);
}

async function writeLimit(env: Pick<Env, "APP_KV">, namespace: string, tool: string, before: LimitRecord | null, now: Date, auto: boolean): Promise<void> {
  const kept = (before?.auto ?? []).filter((at) => now.getTime() - Date.parse(at) < DAY_MS);
  const next: LimitRecord = { last: now.toISOString(), auto: auto ? [...kept, now.toISOString()] : kept };
  await env.APP_KV.put(limitKey(namespace, tool), JSON.stringify(next), { expirationTtl: 2 * 86_400 });
}

export type RepairOutcome =
  | { ran: false; refusal: string }
  | { ran: true; call: OperatorCall; line: string; recorded: boolean };

/** Run one repair on one site. Refused, with nothing sent, when the site has no usable
 *  operator configuration, the tool is not allowed, or the rate limit holds. */
export async function runSiteRepair(
  env: Env,
  args: { namespace: string; tool: string; actor: string; auto: boolean; via: string },
  now: Date,
  fetchImpl: FetchLike = fetch,
  site?: { origin: string; operator: SiteOperator }
): Promise<RepairOutcome> {
  let target = site;
  if (!target) {
    const row = await readSiteRow(env.DB, args.namespace);
    if (!row?.origin) return { ran: false, refusal: `${args.namespace} is not a configured site.` };
    if (!row.operator) return { ran: false, refusal: row.operator_problem ?? `${args.namespace} has no operator API configured, so Capsid may call nothing on it.` };
    target = { origin: row.origin, operator: row.operator };
  }
  const refusal = toolRefusal(target.operator, args.tool);
  if (refusal) return { ran: false, refusal };
  const before = await readLimit(env, args.namespace, args.tool);
  const wait = limitRefusal(before, now, args.auto);
  if (wait) return { ran: false, refusal: `${args.tool} on ${args.namespace} waits: ${wait}` };
  // The limit is written before the call, so two callers racing cannot both go.
  await writeLimit(env, args.namespace, args.tool, before, now, args.auto);
  const started = new Date();
  const call = await callOperator(env, target, args.tool, fetchImpl);
  const line = callLine(args.tool, call);
  const finished = new Date();
  // The record of a call that left the Worker. A failed write is logged and said, and the
  // call's own result still goes back: it happened.
  let recorded = true;
  try {
    await env.DB.batch([
      auditStatement(env.DB, args.actor, REPAIR_AUDIT_ACTION, args.namespace, null, {
        tool: args.tool,
        via: args.via,
        status: call.status,
        converged: call.converged,
        expected: call.expected,
        present: call.present,
        error: call.error,
      }),
      ...taskRunStatements(env.DB, "site-repair", started, finished, call.ok && call.converged !== false ? "ok" : "refused", `${args.namespace}: ${line} (${args.via})`),
    ]);
  } catch (err) {
    recorded = false;
    logEvent("error", "SITE_REPAIR_NOT_RECORDED", { message: `SITE_REPAIR_NOT_RECORDED ${args.namespace} ${args.tool}: ${err instanceof Error ? err.message : String(err)}` });
  }
  return { ran: true, call, line, recorded };
}
