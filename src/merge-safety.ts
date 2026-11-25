import { ACTOR, AUDIT_ROWS_LIMIT, WINDOW_MS, revertsTick } from "./merge-reverts";
import { AUTO_MERGED_APPROVAL_REASON } from "./approval-executor";
import { loadMergePolicy } from "./auto-merge-policy";
import type { Env } from "./env";
import type { OpsMergeSafety, OpsMergeSafetyRow } from "./ops-types/feed";
import { auditStatement } from "./store-guards";
import { timeMs } from "./time";
import { DAY_MS } from "./time";

// Three parts, none a D1 migration (audit_log rows and APP_KV only): 1. Revert tracking. 2. The
// meter: the last seven days per namespace, in APP_KV, so the status tool, the Portal feed and the
// phone alerts read it with no D1 or GitHub read.

export const PAUSED_KEY = "merge-safety:paused";
export const LIFTED_KEY = "merge-safety:lifted";
export const REPORT_KEY = "merge-safety:report";

const WEEK_MS = 7 * DAY_MS;
// The previous 30 days are days 7 to 37 before now; the audit window also has to reach the merge a
// rollback is joined to, so it is the merge units' 90.
const BASELINE_MS = 30 * DAY_MS;
const PAUSE_BAD_COUNT = 2;
const PAUSE_RATE_FACTOR = 3;

export interface Paused {
  since: string;
  reason: string;
}
export interface AuditEvidence {
  action: string;
  namespace: string | null;
  params: string | null;
  at: string;
}

export interface OutcomeEvidence {
  namespace: string;
  repo: string;
  pr: number | null;
  outcome: string;
  run_at: string;
}

export interface SafetyCounts {
  namespace: string;
  auto_merged: number;
  approved: number;
  deploys_verified: number;
  rolled_back: number;
  rollback_failed: number;
  reverts: number;
  bad_auto_7d: number;
  bad_at: Array<{ key: string; ms: number }>;
  auto_at: number[];
}

function paramsOf(row: AuditEvidence): Record<string, unknown> {
  try {
    const parsed: unknown = row.params ? JSON.parse(row.params) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function countsFrom(
  audit: readonly AuditEvidence[],
  outcomes: readonly OutcomeEvidence[],
  namespaces: readonly string[],
  now: Date,
): SafetyCounts[] {
  const t = now.getTime();
  const out = new Map<string, SafetyCounts>();
  const get = (ns: string): SafetyCounts =>
    out.get(ns) ??
    (out.set(ns, {
      namespace: ns,
      auto_merged: 0,
      approved: 0,
      deploys_verified: 0,
      rolled_back: 0,
      rollback_failed: 0,
      reverts: 0,
      bad_auto_7d: 0,
      bad_at: [],
      auto_at: [],
    }),
    out.get(ns)!);
  for (const ns of namespaces) get(ns);
  const inWeek = (ms: number) => ms > t - WEEK_MS && ms <= t;
  const inReach = (ms: number) => ms > t - WEEK_MS - BASELINE_MS && ms <= t;

  const autoPrs = new Set<string>();
  for (const a of audit) {
    if (a.action !== "auto-merged" || !a.namespace) continue;
    const p = paramsOf(a);
    autoPrs.add(`${a.namespace} ${String(p.repo)}#${String(p.pr)}`);
    const ms = timeMs(a.at);
    const c = get(a.namespace);
    if (inWeek(ms)) c.auto_merged++;
    if (inReach(ms)) c.auto_at.push(ms);
  }

  const badEvents = new Map<string, { ns: string; ms: number[] }>();
  const bad = (ns: string, repo: string, pr: number | null, ms: number) => {
    if (pr === null || !autoPrs.has(`${ns} ${repo}#${pr}`)) return;
    const key = `${ns} ${repo}#${pr}`;
    const seen = badEvents.get(key) ?? { ns, ms: [] };
    seen.ms.push(ms);
    badEvents.set(key, seen);
  };

  for (const a of audit) {
    if (!a.namespace) continue;
    const c = get(a.namespace);
    const p = paramsOf(a);
    if (a.action === "approved-merged") {
      if (p.reason === AUTO_MERGED_APPROVAL_REASON) continue;
      if (inWeek(timeMs(a.at))) c.approved++;
    } else if (a.action === "auto-merge-reverted") {
      const ms =
        typeof p.merged_at === "string" && Number.isFinite(Date.parse(p.merged_at))
          ? Date.parse(p.merged_at)
          : timeMs(a.at);
      if (inWeek(ms)) c.reverts++;
      bad(a.namespace, String(p.repo), typeof p.pr === "number" ? p.pr : null, ms);
    }
  }
  for (const o of outcomes) {
    const c = get(o.namespace);
    const ms = timeMs(o.run_at);
    if (o.outcome === "verified" && inWeek(ms)) c.deploys_verified++;
    if (o.outcome === "rolled_back" || o.outcome === "rollback_failed") {
      if (inWeek(ms)) c[o.outcome]++;
      bad(o.namespace, o.repo, o.pr, ms);
    }
  }
  for (const [key, { ns, ms }] of badEvents) {
    const c = get(ns);
    for (const m of ms) if (inReach(m)) c.bad_at.push({ key, ms: m });
    if (ms.some(inWeek)) c.bad_auto_7d++;
  }
  return [...out.values()];
}

/** The evidence from D1 and the counts from it. Reads only: two statements. */
async function readSafetyCounts(
  env: Env,
  now: Date,
  namespaces: readonly string[],
): Promise<SafetyCounts[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const sqlite = since.toISOString().slice(0, 19).replace("T", " ");
  const [audit, outcomes] = await Promise.all([
    env.DB.prepare(
      `SELECT action, namespace, params, at FROM audit_log WHERE action IN ('auto-merged', 'approved-merged', 'auto-merge-reverted') AND at >= ?1 ORDER BY id DESC LIMIT ?2`,
    )
      .bind(sqlite, AUDIT_ROWS_LIMIT)
      .all<AuditEvidence>(),
    env.DB.prepare(
      `SELECT namespace, repo, pr, outcome, run_at FROM deploy_outcomes WHERE run_at >= ?1 AND outcome IN ('verified', 'rolled_back', 'rollback_failed') ORDER BY run_at LIMIT ?2`,
    )
      .bind(since.toISOString(), AUDIT_ROWS_LIMIT)
      .all<OutcomeEvidence>(),
  ]);
  return countsFrom(audit.results ?? [], outcomes.results ?? [], namespaces, now);
}

function windowed(c: SafetyCounts, lifted: string | undefined, now: Date) {
  const t = now.getTime();
  const after = lifted && Number.isFinite(Date.parse(lifted)) ? Date.parse(lifted) : -Infinity;
  const week = (ms: number) => ms > t - WEEK_MS;
  const byPr = new Map<string, number>();
  for (const e of c.bad_at)
    if (e.ms > after) byPr.set(e.key, Math.max(byPr.get(e.key) ?? -Infinity, e.ms));
  const latest = [...byPr.values()];
  return {
    bad7: latest.filter(week).length,
    bad30: latest.filter((ms) => !week(ms)).length,
    auto7: c.auto_at.filter(week).length,
    auto30: c.auto_at.filter((ms) => !week(ms)).length,
  };
}

/**
 * Pause when 2 or more of the tick's own merges were rolled back or reverted in 7 days, or when
 * the 7-day rate (bad over merges, merges floored at 1) is more than 3 times the rate over days 7
 * to 37. The rate rule needs a nonzero baseline (at least one bad event and at least one merge):
 * with a clean baseline the rate is infinite for any first event, and one bad event alone is the
 * merge units' job, not a namespace's, so only the count rule applies there.
 */
export function judgeShutoff(
  counts: readonly SafetyCounts[],
  paused: Readonly<Record<string, Paused>>,
  lifted: Readonly<Record<string, string>>,
  now: Date,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of counts) {
    if (paused[c.namespace]) continue;
    const w = windowed(c, lifted[c.namespace], now);
    if (w.bad7 >= PAUSE_BAD_COUNT) {
      out[c.namespace] =
        `${w.bad7} of the pull requests auto-merge merged were rolled back or reverted in 7 days`;
      continue;
    }
    if (w.bad30 >= 1 && w.auto30 >= 1) {
      const rate7 = w.bad7 / Math.max(w.auto7, 1);
      const rate30 = w.bad30 / w.auto30;
      if (rate7 > PAUSE_RATE_FACTOR * rate30) {
        out[c.namespace] =
          `${w.bad7} of ${w.auto7} auto-merged pull request(s) rolled back or reverted in 7 days, over ${PAUSE_RATE_FACTOR} times the ${w.bad30} of ${w.auto30} in the 30 days before`;
      }
    }
  }
  return out;
}

/**
 * The paused namespaces, as the tick reads them. A value that does not read throws, and the caller
 * holds every namespace (fail closed), as for the suspended units.
 */
export async function readPaused(kv: KVNamespace): Promise<Record<string, Paused>> {
  const raw = await kv.get(PAUSED_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${PAUSED_KEY} is not a map of namespaces`);
  return parsed as Record<string, Paused>;
}

export async function readLifted(
  kv: KVNamespace,
  key: string = LIFTED_KEY,
): Promise<Record<string, string>> {
  const raw = await kv.get(key);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

function reportFrom(
  counts: readonly SafetyCounts[],
  paused: Readonly<Record<string, Paused>>,
  lifted: Readonly<Record<string, string>>,
  now: Date,
): OpsMergeSafety {
  const rows: OpsMergeSafetyRow[] = counts
    .map((c) => ({
      namespace: c.namespace,
      auto_merged: c.auto_merged,
      approved: c.approved,
      deploys_verified: c.deploys_verified,
      rolled_back: c.rolled_back,
      rollback_failed: c.rollback_failed,
      reverts: c.reverts,
      bad_auto_7d: windowed(c, lifted[c.namespace], now).bad7,
      paused: paused[c.namespace] ?? null,
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
  return { generated: now.toISOString(), namespaces: rows };
}

export interface SafetyTickReport {
  ran: boolean;
  note: string;
  newly_paused: string[];
}

/**
 * One pass: count the week, pause a namespace the counts condemn, store the report. `namespaces`
 * are those the signed policy covers (empty when it did not load).
 */
export async function safetyTick(
  env: Env,
  now: Date,
  namespaces: readonly string[] = [],
): Promise<SafetyTickReport> {
  const before = await readPaused(env.APP_KV);
  const lifted = await readLifted(env.APP_KV);
  const counts = await readSafetyCounts(env, now, namespaces);
  const added = judgeShutoff(counts, before, lifted, now);
  const since = now.toISOString();
  const names = Object.keys(added);
  let paused: Record<string, Paused> = { ...before };
  if (names.length) {
    // Read again just before writing and add only the new namespaces to that value, so a resume that
    // landed while the counts were read is not written back over. KV has no compare-and-set: this
    // narrows the window and does not close it.
    paused = {
      ...(await readPaused(env.APP_KV)),
      ...Object.fromEntries(Object.entries(added).map(([ns, reason]) => [ns, { since, reason }])),
    };
    // The pause first: if the audit row then fails, the namespace is held and the next tick finds it
    // already paused and writes no row, which costs a row, not the hold.
    await env.APP_KV.put(PAUSED_KEY, JSON.stringify(paused));
    await env.DB.batch(
      names.map((ns) =>
        auditStatement(env.DB, ACTOR, "auto-merge-paused", ns, null, {
          reason: added[ns],
          since,
          counts: reportFrom(counts, paused, lifted, now).namespaces.find(
            (r) => r.namespace === ns,
          ),
        }),
      ),
    );
  }
  const report = reportFrom(counts, paused, lifted, now);
  const previous = await env.APP_KV.get(REPORT_KEY);
  const stable = (r: OpsMergeSafety) => JSON.stringify({ ...r, generated: "" });
  let changed = true;
  try {
    changed = !previous || stable(JSON.parse(previous) as OpsMergeSafety) !== stable(report);
  } catch {
    // An unreadable report is replaced.
  }
  if (changed) await env.APP_KV.put(REPORT_KEY, JSON.stringify(report));
  if (!names.length && !changed) return { ran: false, note: "no change", newly_paused: [] };
  return {
    ran: true,
    note: `${report.namespaces.length} namespace(s) counted${names.length ? `; paused: ${names.map((n) => `${n} (${added[n]})`).join(", ")}` : ""}`,
    newly_paused: names,
  };
}

export interface MergeSafetyTickReport {
  ran: boolean;
  note: string;
  newly_paused: string[];
}

export async function mergeSafetyTick(env: Env, now: Date): Promise<MergeSafetyTickReport> {
  const loaded = await loadMergePolicy(env);
  const reverts = await revertsTick(env, now, loaded);
  const safety = await safetyTick(env, now, "policy" in loaded ? loaded.policy.namespaces : []);
  if (!reverts.ran && !safety.ran) return { ran: false, note: safety.note, newly_paused: [] };
  return {
    ran: true,
    note: [reverts.recorded.length ? reverts.note : null, safety.ran ? safety.note : null]
      .filter(Boolean)
      .join("; "),
    newly_paused: safety.newly_paused,
  };
}

export async function readSafetyReport(kv: KVNamespace): Promise<OpsMergeSafety | null> {
  const raw = await kv.get(REPORT_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OpsMergeSafety;
    return Array.isArray(parsed.namespaces) ? parsed : null;
  } catch {
    return null;
  }
}

/** What lifting a namespace's pause will do, or why it cannot. Reads only. */
export async function planResume(
  kv: KVNamespace,
  rawNamespace: string | undefined,
): Promise<{ ok: true; namespace: string; paused: Paused } | { ok: false; refusal: string }> {
  const namespace = (rawNamespace ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(namespace))
    return {
      ok: false,
      refusal: `automerge_resume needs a namespace, for example 'capsid'; got '${rawNamespace ?? ""}'.`,
    };
  const paused = (await readPaused(kv))[namespace];
  if (!paused)
    return {
      ok: false,
      refusal: `auto-merge for ${namespace} is not paused, so there is nothing to lift.`,
    };
  return { ok: true, namespace, paused };
}

export async function resumeNamespace(
  env: Env,
  actor: string,
  rawNamespace: string | undefined,
  reason: string,
  now: Date,
): Promise<{ ok: true; summary: string } | { ok: false; refusal: string }> {
  const plan = await planResume(env.APP_KV, rawNamespace);
  if (!plan.ok) return plan;
  const lifted = { ...(await readLifted(env.APP_KV)), [plan.namespace]: now.toISOString() };
  await env.APP_KV.put(LIFTED_KEY, JSON.stringify(lifted));
  // Read again just before writing, so a pause of another namespace that landed since the plan is
  // kept. KV has no compare-and-set: this narrows the window and does not close it.
  const rest = await readPaused(env.APP_KV);
  delete rest[plan.namespace];
  await env.APP_KV.put(PAUSED_KEY, JSON.stringify(rest));
  await env.DB.batch([
    auditStatement(env.DB, actor, "auto-merge-resumed", plan.namespace, null, {
      namespace: plan.namespace,
      reason,
      was: plan.paused,
    }),
  ]);
  return {
    ok: true,
    summary: `Lifted the pause on auto-merge for ${plan.namespace}. The tick may merge its pull requests unattended again; new bad merges pause it again.`,
  };
}
