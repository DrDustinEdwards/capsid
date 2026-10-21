import { AUTO_MERGED_APPROVAL_REASON } from "./approval-executor";
import { loadMergePolicy } from "./auto-merge-policy";
import type { Env } from "./env";
import { ghFetch, resolveRepo } from "./github/client";
import { logEvent } from "./log";
import type { OpsMergeSafety, OpsMergeSafetyRow } from "./ops-types/feed";
import { auditStatement } from "./store-guards";
import { timeMs } from "./trends";
import { passDue } from "./watcher";
import { DAY_MS } from "./time";

// THE AUTO-MERGE SAFETY METER AND SHUTOFF (docs/design/design-merge-pipeline.md, "The
// safety meter"). Merge units (src/merge-units.ts) narrow one path class after a bad
// unattended merge; this narrows the whole namespace. It only narrows: the tick stops
// merging that namespace's pull requests unattended and they fall to class approve, and
// Dustin's approvals still execute. Lifting it is the automerge_resume control.
//
// Three parts, none of them a D1 migration (audit_log rows and APP_KV only):
//   1. Revert tracking. A merged pull request that reverts one the tick auto-merged is
//      recorded as an `auto-merge-reverted` audit row. A rollback is the deploy gate's
//      verdict; a revert is Dustin's (or a driver's) verdict, and nothing else records it.
//   2. The meter: the last seven days per namespace, written to APP_KV so the status
//      tool, the Portal feed and the phone alerts read it with no D1 or GitHub read.
//   3. The shutoff: a namespace pauses when 2 or more of the pull requests the tick merged
//      were rolled back or reverted in 7 days, or when that rate is more than 3 times the
//      rate over the 30 days before.

export const PAUSED_KEY = "merge-safety:paused";
export const LIFTED_KEY = "merge-safety:lifted";
export const REPORT_KEY = "merge-safety:report";
export const REVERTS_STAMP_KEY = "merge-safety:reverts-last";

const WEEK_MS = 7 * DAY_MS;
// The previous 30 days are days 7 to 37 before now; the audit window also has to reach
// the merge a rollback is joined to, so it is the merge units' 90.
const BASELINE_MS = 30 * DAY_MS;
const WINDOW_MS = 90 * DAY_MS;
const PAUSE_BAD_COUNT = 2;
const PAUSE_RATE_FACTOR = 3;
const REVERTS_EVERY_MINUTES = 30;
const CLOSED_PRS_READ = 50;
const AUDIT_ROWS_LIMIT = 5000;
const ACTOR = "capsid:merge-safety";

export interface Paused {
  since: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// 1. Revert tracking

/** The pull requests and commits a merged pull request says it reverts. Pure.
 *  Recognised: GitHub's revert button ("Reverts owner/repo#N" in the body, with a title
 *  `Revert "..."`), "reverts #N" or "revert #N" at the start of the title or of a body line
 *  (same repo only, any letter case), and git's "This reverts commit <sha>" (7 to 40 hex). A mention of
 *  another repo's pull request names none of this repo's. */
export function revertTargets(title: string, body: string, repo: string): { prs: number[]; shas: string[] } {
  const prs = new Set<number>();
  const shas = new Set<string>();
  const text = `${title ?? ""}\n${body ?? ""}`;
  for (const m of text.matchAll(/\breverts?\s+([\w.-]+\/[\w.-]+)#(\d+)\b/gi)) {
    if (m[1]!.toLowerCase() === repo.toLowerCase()) prs.add(Number(m[2]));
  }
  // A bare "revert #N" is a statement only at the start of the title or of a body line
  // (after a list marker at most): "Don't revert #12 here" is prose and names nothing.
  const lead = /^[ \t]*(?:[-*][ \t]+)?reverts?\s+#(\d+)\b/gim;
  for (const m of `${title ?? ""}\n${body ?? ""}`.matchAll(lead)) prs.add(Number(m[1]));
  for (const m of text.matchAll(/\bThis reverts commit\s+([0-9a-f]{7,40})\b/gi)) shas.add(m[1]!.toLowerCase());
  return { prs: [...prs].sort((a, b) => a - b), shas: [...shas] };
}

interface ClosedPr {
  number: number;
  title?: string | null;
  body?: string | null;
  merged_at?: string | null;
}

interface AutoMergedRow {
  repo: string;
  pr: number;
  head_sha: string | null;
  path_class: string | null;
}

/** The auto-merged audit row for a pull request, or for a commit by its sha prefix
 *  (merge_sha or head_sha). The same query shape the merge units use. */
async function autoMergedBy(env: Env, namespace: string, repo: string, target: { pr: number } | { sha: string }): Promise<AutoMergedRow | null> {
  const row =
    "pr" in target
      ? await env.DB.prepare(
          `SELECT params FROM audit_log WHERE action = 'auto-merged' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2 AND json_extract(params, '$.pr') = ?3 ORDER BY id DESC LIMIT 1`
        )
          .bind(namespace, repo, target.pr)
          .first<{ params: string }>()
      : // The sha is hex by the pattern that found it, so the prefix carries no wildcard.
        await env.DB.prepare(
          `SELECT params FROM audit_log WHERE action = 'auto-merged' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2
             AND (json_extract(params, '$.merge_sha') LIKE ?3 OR json_extract(params, '$.head_sha') LIKE ?3) ORDER BY id DESC LIMIT 1`
        )
          .bind(namespace, repo, `${target.sha}%`)
          .first<{ params: string }>();
  if (!row) return null;
  const p = JSON.parse(row.params) as { repo: string; pr: number; head_sha?: string | null; path_class?: string | null };
  return { repo: p.repo, pr: p.pr, head_sha: p.head_sha ?? null, path_class: p.path_class ?? null };
}

export interface RevertsReport {
  ran: boolean;
  note: string;
  recorded: string[];
}

/** One namespace's revert pass: the recently merged pull requests that revert an
 *  auto-merged one, each recorded once. Returns what it recorded. */
export async function recordReverts(env: Env, namespace: string, now: Date): Promise<string[]> {
  const { owner, repo } = await resolveRepo(env, namespace);
  const full = `${owner}/${repo}`;
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PRS_READ}`);
  if (!resp.ok) throw new Error(`the closed pull requests of ${full} returned ${resp.status}`);
  const recorded: string[] = [];
  for (const closed of (await resp.json()) as ClosedPr[]) {
    if (!closed.merged_at) continue;
    // A revert older than the evidence window answers nothing the meter still reads.
    if (now.getTime() - Date.parse(closed.merged_at) > WINDOW_MS) continue;
    const targets = revertTargets(closed.title ?? "", closed.body ?? "", full);
    const reverted = new Map<number, AutoMergedRow>();
    for (const pr of targets.prs) {
      const row = await autoMergedBy(env, namespace, full, { pr });
      if (row) reverted.set(row.pr, row);
    }
    for (const sha of targets.shas) {
      const row = await autoMergedBy(env, namespace, full, { sha });
      if (row) reverted.set(row.pr, row);
    }
    for (const row of reverted.values()) {
      // A pull request does not revert itself, and one revert is recorded once per
      // reverted pull request however many ticks see it.
      if (row.pr === closed.number) continue;
      const seen = await env.DB.prepare(
        `SELECT 1 AS found FROM audit_log WHERE action = 'auto-merge-reverted' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2
           AND json_extract(params, '$.pr') = ?3 AND json_extract(params, '$.reverted_by') = ?4 LIMIT 1`
      )
        .bind(namespace, full, row.pr, closed.number)
        .first<{ found: number }>();
      if (seen) continue;
      await env.DB.batch([
        auditStatement(env.DB, ACTOR, "auto-merge-reverted", namespace, null, {
          repo: full,
          pr: row.pr,
          reverted_by: closed.number,
          head_sha: row.head_sha,
          path_class: row.path_class,
          merged_at: closed.merged_at,
          at: now.toISOString(),
        }),
      ]);
      recorded.push(`${full}#${row.pr} by #${closed.number}`);
    }
  }
  return recorded;
}

/** The revert pass over every namespace the signed merge policy covers, at most once in
 *  30 minutes (a KV stamp, like the watcher's). A policy that does not load, or a GitHub
 *  failure for one namespace, is logged and the rest go on. */
export async function revertsTick(env: Env, now: Date, policy?: Awaited<ReturnType<typeof loadMergePolicy>>): Promise<RevertsReport> {
  const last = await env.APP_KV.get(REVERTS_STAMP_KEY).catch(() => null);
  const due = passDue(last, REVERTS_EVERY_MINUTES, now);
  if (!due.due) return { ran: false, note: due.reason, recorded: [] };
  const loaded = policy ?? (await loadMergePolicy(env));
  if ("error" in loaded) return { ran: false, note: loaded.error, recorded: [] };
  const recorded: string[] = [];
  for (const namespace of loaded.policy.namespaces) {
    try {
      recorded.push(...(await recordReverts(env, namespace, now)));
    } catch (err) {
      logEvent("error", "MERGE_SAFETY", { message: `MERGE_SAFETY could not read the reverts of ${namespace}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  await env.APP_KV.put(REVERTS_STAMP_KEY, now.toISOString());
  return { ran: true, note: `${recorded.length} revert(s) of auto-merged pull requests recorded${recorded.length ? `: ${recorded.join(", ")}` : ""}`, recorded };
}

// ---------------------------------------------------------------------------
// 2. The weekly counts

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
  // The last seven days.
  auto_merged: number;
  approved: number;
  deploys_verified: number;
  rolled_back: number;
  rollback_failed: number;
  reverts: number;
  // Rollbacks and reverts of pull requests the tick merged unattended, one per pull
  // request however many deploys or reverts it drew, before the lifted time is applied.
  bad_auto_7d: number;
  // The times (ms) behind the judgement, over days 0 to 37: each bad event of an
  // unattended pull request, and each unattended merge. judgeShutoff windows and lifts
  // them, counting a pull request once per window at its latest event after the lift.
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

/** The counts per namespace from the evidence. Pure. `namespaces` are listed even with
 *  no event; one seen in the evidence is added. A pull request counts as bad once, at its
 *  first rollback or revert, so one incident is not two. */
export function countsFrom(audit: readonly AuditEvidence[], outcomes: readonly OutcomeEvidence[], namespaces: readonly string[], now: Date): SafetyCounts[] {
  const t = now.getTime();
  const out = new Map<string, SafetyCounts>();
  const get = (ns: string): SafetyCounts =>
    out.get(ns) ?? (out.set(ns, { namespace: ns, auto_merged: 0, approved: 0, deploys_verified: 0, rolled_back: 0, rollback_failed: 0, reverts: 0, bad_auto_7d: 0, bad_at: [], auto_at: [] }), out.get(ns)!);
  for (const ns of namespaces) get(ns);
  const inWeek = (ms: number) => ms > t - WEEK_MS && ms <= t;
  const inReach = (ms: number) => ms > t - WEEK_MS - BASELINE_MS && ms <= t;

  // The unattended merges, by pull request, for the join below.
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

  // Every bad event of each unattended pull request, kept so judgeShutoff can take the
  // latest one after a resume (a fresh revert of a PR rolled back long ago counts).
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
      // A policy merge of a pull request that held an approval also closes the approval
      // with an approved-merged row; that row is the same merge (src/trends.ts).
      if (p.reason === AUTO_MERGED_APPROVAL_REASON) continue;
      if (inWeek(timeMs(a.at))) c.approved++;
    } else if (a.action === "auto-merge-reverted") {
      const ms = typeof p.merged_at === "string" && Number.isFinite(Date.parse(p.merged_at)) ? Date.parse(p.merged_at) : timeMs(a.at);
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
    // A pull request is one bad event this week however many it drew.
    if (ms.some(inWeek)) c.bad_auto_7d++;
  }
  return [...out.values()];
}

/** The evidence from D1 and the counts from it. Reads only: two statements. */
async function readSafetyCounts(env: Env, now: Date, namespaces: readonly string[]): Promise<SafetyCounts[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const sqlite = since.toISOString().slice(0, 19).replace("T", " ");
  const [audit, outcomes] = await Promise.all([
    env.DB.prepare(
      `SELECT action, namespace, params, at FROM audit_log WHERE action IN ('auto-merged', 'approved-merged', 'auto-merge-reverted') AND at >= ?1 ORDER BY id DESC LIMIT ?2`
    )
      .bind(sqlite, AUDIT_ROWS_LIMIT)
      .all<AuditEvidence>(),
    env.DB.prepare(`SELECT namespace, repo, pr, outcome, run_at FROM deploy_outcomes WHERE run_at >= ?1 AND outcome IN ('verified', 'rolled_back', 'rollback_failed') ORDER BY run_at LIMIT ?2`)
      .bind(since.toISOString(), AUDIT_ROWS_LIMIT)
      .all<OutcomeEvidence>(),
  ]);
  return countsFrom(audit.results ?? [], outcomes.results ?? [], namespaces, now);
}

// ---------------------------------------------------------------------------
// 3. The shutoff

/** The bad events and unattended merges of a namespace in the last seven days and in
 *  the 30 days before, with the events at or before the lifted time left out. */
function windowed(c: SafetyCounts, lifted: string | undefined, now: Date) {
  const t = now.getTime();
  const after = lifted && Number.isFinite(Date.parse(lifted)) ? Date.parse(lifted) : -Infinity;
  const week = (ms: number) => ms > t - WEEK_MS;
  // One event per pull request: its latest after the lifted time.
  const byPr = new Map<string, number>();
  for (const e of c.bad_at) if (e.ms > after) byPr.set(e.key, Math.max(byPr.get(e.key) ?? -Infinity, e.ms));
  const latest = [...byPr.values()];
  return {
    bad7: latest.filter(week).length,
    bad30: latest.filter((ms) => !week(ms)).length,
    auto7: c.auto_at.filter(week).length,
    auto30: c.auto_at.filter((ms) => !week(ms)).length,
  };
}

/** The namespaces to pause now, each with its reason. Pure.
 *  Pause when 2 or more of the tick's own merges were rolled back or reverted in 7 days,
 *  or when the 7-day rate (bad over merges, merges floored at 1) is more than 3 times the
 *  rate over days 7 to 37. The rate rule needs a nonzero baseline (at least one bad
 *  event and at least one merge): with a clean baseline the rate is infinite for any
 *  first event, and one bad event alone is the merge units' job, not a namespace's, so
 *  only the count rule applies there. Events at or before the namespace's lifted time are
 *  answered and count for nothing. A namespace already paused is not paused again. */
export function judgeShutoff(counts: readonly SafetyCounts[], paused: Readonly<Record<string, Paused>>, lifted: Readonly<Record<string, string>>, now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of counts) {
    if (paused[c.namespace]) continue;
    const w = windowed(c, lifted[c.namespace], now);
    if (w.bad7 >= PAUSE_BAD_COUNT) {
      out[c.namespace] = `${w.bad7} of the pull requests auto-merge merged were rolled back or reverted in 7 days`;
      continue;
    }
    if (w.bad30 >= 1 && w.auto30 >= 1) {
      const rate7 = w.bad7 / Math.max(w.auto7, 1);
      const rate30 = w.bad30 / w.auto30;
      if (rate7 > PAUSE_RATE_FACTOR * rate30) {
        out[c.namespace] = `${w.bad7} of ${w.auto7} auto-merged pull request(s) rolled back or reverted in 7 days, over ${PAUSE_RATE_FACTOR} times the ${w.bad30} of ${w.auto30} in the 30 days before`;
      }
    }
  }
  return out;
}

/** The paused namespaces, as the tick reads them. A value that does not read throws, and
 *  the caller holds every namespace (fail closed), as for the suspended units. */
export async function readPaused(kv: KVNamespace): Promise<Record<string, Paused>> {
  const raw = await kv.get(PAUSED_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${PAUSED_KEY} is not a map of namespaces`);
  return parsed as Record<string, Paused>;
}

async function readLifted(kv: KVNamespace): Promise<Record<string, string>> {
  const raw = await kv.get(LIFTED_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

function reportFrom(counts: readonly SafetyCounts[], paused: Readonly<Record<string, Paused>>, lifted: Readonly<Record<string, string>>, now: Date): OpsMergeSafety {
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

/** One pass: count the week, pause a namespace the counts condemn, store the report.
 *  `namespaces` are those the signed policy covers (empty when it did not load). */
export async function safetyTick(env: Env, now: Date, namespaces: readonly string[] = []): Promise<SafetyTickReport> {
  const before = await readPaused(env.APP_KV);
  const lifted = await readLifted(env.APP_KV);
  const counts = await readSafetyCounts(env, now, namespaces);
  const added = judgeShutoff(counts, before, lifted, now);
  const since = now.toISOString();
  const names = Object.keys(added);
  let paused: Record<string, Paused> = { ...before };
  if (names.length) {
    // Read again just before writing and add only the new namespaces to that value, so a
    // resume that landed while the counts were read is not written back over. KV has no
    // compare-and-set: this narrows the window and does not close it.
    paused = { ...(await readPaused(env.APP_KV)), ...Object.fromEntries(Object.entries(added).map(([ns, reason]) => [ns, { since, reason }])) };
    // The pause first: if the audit row then fails, the namespace is held and the next
    // tick finds it already paused and writes no row, which costs a row, not the hold.
    await env.APP_KV.put(PAUSED_KEY, JSON.stringify(paused));
    await env.DB.batch(
      names.map((ns) =>
        auditStatement(env.DB, ACTOR, "auto-merge-paused", ns, null, { reason: added[ns], since, counts: reportFrom(counts, paused, lifted, now).namespaces.find((r) => r.namespace === ns) })
      )
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

/** What the tick calls: the revert pass (half-hourly), then the meter and the shutoff. */
export async function mergeSafetyTick(env: Env, now: Date): Promise<MergeSafetyTickReport> {
  // The policy is loaded (and its signature checked) once for both passes.
  const loaded = await loadMergePolicy(env);
  const reverts = await revertsTick(env, now, loaded);
  const safety = await safetyTick(env, now, "policy" in loaded ? loaded.policy.namespaces : []);
  if (!reverts.ran && !safety.ran) return { ran: false, note: safety.note, newly_paused: [] };
  return { ran: true, note: [reverts.recorded.length ? reverts.note : null, safety.ran ? safety.note : null].filter(Boolean).join("; "), newly_paused: safety.newly_paused };
}

/** The meter as the status tool and the Portal read it, or null before the first pass.
 *  An unreadable report reads as none. */
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

// ---------------------------------------------------------------------------
// 6. Resume

/** What lifting a namespace's pause will do, or why it cannot. Reads only. */
export async function planResume(kv: KVNamespace, rawNamespace: string | undefined): Promise<{ ok: true; namespace: string; paused: Paused } | { ok: false; refusal: string }> {
  const namespace = (rawNamespace ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(namespace)) return { ok: false, refusal: `automerge_resume needs a namespace, for example 'capsid'; got '${rawNamespace ?? ""}'.` };
  const paused = (await readPaused(kv))[namespace];
  if (!paused) return { ok: false, refusal: `auto-merge for ${namespace} is not paused, so there is nothing to lift.` };
  return { ok: true, namespace, paused };
}

/** Lift a namespace's pause: the tick may merge its pull requests unattended again, and
 *  the rollbacks and reverts before now count against it no more. Audited. */
export async function resumeNamespace(env: Env, actor: string, rawNamespace: string | undefined, reason: string, now: Date): Promise<{ ok: true; summary: string } | { ok: false; refusal: string }> {
  const plan = await planResume(env.APP_KV, rawNamespace);
  if (!plan.ok) return plan;
  const lifted = { ...(await readLifted(env.APP_KV)), [plan.namespace]: now.toISOString() };
  await env.APP_KV.put(LIFTED_KEY, JSON.stringify(lifted));
  // Read again just before writing, so a pause of another namespace that landed since the
  // plan is kept. KV has no compare-and-set: this narrows the window and does not close it.
  const rest = await readPaused(env.APP_KV);
  delete rest[plan.namespace];
  await env.APP_KV.put(PAUSED_KEY, JSON.stringify(rest));
  await env.DB.batch([auditStatement(env.DB, actor, "auto-merge-resumed", plan.namespace, null, { namespace: plan.namespace, reason, was: plan.paused })]);
  return { ok: true, summary: `Lifted the pause on auto-merge for ${plan.namespace}. The tick may merge its pull requests unattended again; new bad merges pause it again.` };
}
