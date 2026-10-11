import type { Env } from "./env";
import type { InboxItem } from "./ops-types";
import { logEvent } from "./log";
import { auditStatement } from "./store-guards";

// EARNED PROMOTION AND DEMOTION (docs/design/design-merge-pipeline.md section 7, PR 9;
// Dustin's DECIDE 9 and 10 of 2026-10-09). A unit is (namespace, path class). REPORT-ONLY:
// this proposes and never widens anything (conventions 11.3). The one thing it changes on
// its own only narrows: a rollback of a pull request the tick merged unattended suspends
// that unit at once, so the tick stops merging its pull requests unattended and they fall
// to class approve (src/auto-merge-tick.ts reads the suspensions).
//
// Evidence per unit, over 90 days:
//   - approved merges, from pr_approvals (namespace and path_class, migrations/0043);
//   - approvals voided for anything but a new push (an undo, red CI);
//   - rollbacks, from deploy_outcomes, joined to the pull request's unit through the
//     tick's auto-merged audit row or its approval;
//   - reverts of a pull request the tick merged, from the auto-merge-reverted audit rows
//     src/merge-safety.ts records. A revert counts as a rollback of an unattended merge:
//     it suspends the unit and blocks its promotion.
// The CI-green share joins in with the signed unit list (PR 10).
//
// Promotion proposal: at least 20 approved merges over at least 14 days, no rollback or revert, and
// at most one approval voided for anything but a new push. Demotion: a rollback of an
// unattended merge suspends its unit and proposes removing the unit from the signed list.
// Both reach Dustin as inbox items of kind "proposal". Acting on a proposal is a signed
// policy change (the sign_policy_change control, src/policy-sign.ts), and a suspension is
// lifted with the unit_resume control (liftSuspension below).

export const SUSPENDED_KEY = "merge-units:suspended";
export const REPORT_KEY = "merge-units:report";
// When Dustin lifted each unit's suspension (the unit_resume control): a rollback from
// before then is answered and suspends the unit no more.
export const LIFTED_KEY = "merge-units:lifted";
const WINDOW_MS = 90 * 86_400_000;
const PROMOTE_MERGES = 20;
const PROMOTE_SPAN_MS = 14 * 86_400_000;
const PROMOTE_MAX_BAD_VOIDS = 1;
// A void that only says the pull request changed after it was approved is not evidence
// against the unit: the approval was simply of an older head.
const NOT_AGAINST = /^(new push|head moved|replaced)\b/;

export const unitKey = (namespace: string, pathClass: string) => `${namespace}/${pathClass}`;

export interface ApprovalEvidence {
  namespace: string | null;
  path_class: string | null;
  status: string;
  close_reason: string | null;
  closed_at: string | null;
}

export interface RollbackEvidence {
  // A deploy the gate rolled back, or a merged pull request that reverts an unattended
  // merge (src/merge-safety.ts). For a revert, run_at is when the revert merged, run_id
  // is 0 and head_sha is the reverted merge's (zeros when the row has none), and `reverted_by` is the revert's number.
  kind: "rollback" | "revert";
  reverted_by?: number | null;
  namespace: string;
  repo: string;
  pr: number | null;
  head_sha: string;
  run_id: number;
  run_at: string;
  // How the pull request reached the default branch, and its unit, when known.
  merged_by: "tick" | "approval" | "unknown";
  path_class: string | null;
}

export interface Suspension {
  unit: string;
  since: string;
  reason: string;
}

export interface UnitProposal {
  kind: "promote" | "demote";
  unit: string;
  title: string;
  evidence: { approved_merges: number; span_days: number; rollbacks: number; bad_voids: number };
}

export interface UnitsReport {
  generated: string;
  proposals: UnitProposal[];
  suspended: Suspension[];
  // Rollbacks whose pull request's unit could not be found, so nothing was suspended.
  unplaced: string[];
}

const happened = (r: RollbackEvidence) => (r.kind === "revert" ? `was reverted by ${r.repo}#${r.reverted_by}` : "was rolled back");

/** The proposals and the suspensions, from the evidence. Pure. */
export function judgeUnits(
  approvals: readonly ApprovalEvidence[],
  rollbacks: readonly RollbackEvidence[],
  suspended: readonly Suspension[],
  now: Date,
  lifted: Readonly<Record<string, string>> = {}
): UnitsReport {
  const units = new Map<string, { merged: number[]; bad: number; rollbacks: number }>();
  const unit = (k: string) => units.get(k) ?? (units.set(k, { merged: [], bad: 0, rollbacks: 0 }), units.get(k)!);
  for (const a of approvals) {
    if (!a.namespace || !a.path_class) continue;
    const u = unit(unitKey(a.namespace, a.path_class));
    if (a.status === "merged" && a.closed_at) u.merged.push(Date.parse(a.closed_at));
    if (a.status === "voided" && !NOT_AGAINST.test(a.close_reason ?? "")) u.bad++;
  }
  const nowSuspended = new Map(suspended.map((s) => [s.unit, s]));
  const unplaced: string[] = [];
  const demote: UnitProposal[] = [];
  for (const r of rollbacks) {
    if (!r.path_class) {
      unplaced.push(`${r.repo} ${r.kind === "revert" ? `revert #${r.reverted_by}` : `run ${r.run_id}`} at ${r.head_sha.slice(0, 7)}: ${r.pr ? `#${r.pr}'s unit is not recorded` : "no pull request is recorded for it"}`);
      continue;
    }
    const k = unitKey(r.namespace, r.path_class);
    unit(k).rollbacks++;
    if (r.merged_by !== "tick") continue;
    // Dustin lifted the suspension after this rollback: it is answered.
    if (lifted[k] && Date.parse(r.run_at) <= Date.parse(lifted[k]!)) continue;
    if (!nowSuspended.has(k)) nowSuspended.set(k, { unit: k, since: now.toISOString(), reason: `${r.repo}#${r.pr} merged unattended and ${happened(r)}${r.kind === "revert" ? "" : ` (run ${r.run_id})`}` });
    if (!demote.some((d) => d.unit === k)) {
      demote.push({ kind: "demote", unit: k, title: `Remove ${k.replace("/", " ")} from auto: ${r.repo}#${r.pr} merged unattended and ${happened(r)}`, evidence: { approved_merges: 0, span_days: 0, rollbacks: 0, bad_voids: 0 } });
    }
  }
  const promote: UnitProposal[] = [];
  for (const [k, u] of units) {
    const d = demote.find((p) => p.unit === k);
    const span = u.merged.length ? Math.max(...u.merged) - Math.min(...u.merged) : 0;
    const evidence = { approved_merges: u.merged.length, span_days: Math.floor(span / 86_400_000), rollbacks: u.rollbacks, bad_voids: u.bad };
    if (d) d.evidence = evidence;
    if (nowSuspended.has(k)) continue;
    if (u.merged.length >= PROMOTE_MERGES && span >= PROMOTE_SPAN_MS && u.rollbacks === 0 && u.bad <= PROMOTE_MAX_BAD_VOIDS) {
      promote.push({ kind: "promote", unit: k, title: `Promote ${k.replace("/", " ")} to auto: ${u.merged.length} approved over ${evidence.span_days} days, 0 rollbacks`, evidence });
    }
  }
  return { generated: now.toISOString(), proposals: [...demote, ...promote], suspended: [...nowSuspended.values()], unplaced };
}

/** The suspended units, as the tick reads them. An unreadable list reads as none
 *  suspended is not safe, so it throws and the caller decides. */
export async function readSuspended(kv: KVNamespace): Promise<Suspension[]> {
  const raw = await kv.get(SUSPENDED_KEY);
  return raw ? (JSON.parse(raw) as Suspension[]) : [];
}

async function readLifted(kv: KVNamespace): Promise<Record<string, string>> {
  const raw = await kv.get(LIFTED_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

/** What lifting a unit's suspension will do, or why it cannot. Reads only. */
export async function planLift(kv: KVNamespace, rawUnit: string | undefined): Promise<{ ok: true; unit: string; suspension: Suspension } | { ok: false; refusal: string }> {
  const m = /^\s*([a-z0-9-]+)\s*\/\s*([a-z-]+)\s*$/.exec(rawUnit ?? "");
  if (!m) return { ok: false, refusal: `unit_resume needs unit as '<namespace>/<path class>', for example 'capsid/docs'; got '${rawUnit ?? ""}'.` };
  const unit = unitKey(m[1]!, m[2]!);
  const suspension = (await readSuspended(kv)).find((s) => s.unit === unit);
  if (!suspension) return { ok: false, refusal: `${unit} is not suspended, so there is nothing to lift.` };
  return { ok: true, unit, suspension };
}

/** Lift a unit's suspension: the tick may merge its pull requests unattended again, and
 *  the rollbacks before now suspend it no more. Audited. */
export async function liftSuspension(env: Env, actor: string, rawUnit: string | undefined, reason: string, now: Date): Promise<{ ok: true; summary: string } | { ok: false; refusal: string }> {
  const plan = await planLift(env.APP_KV, rawUnit);
  if (!plan.ok) return plan;
  const rest = (await readSuspended(env.APP_KV)).filter((s) => s.unit !== plan.unit);
  const lifted = { ...(await readLifted(env.APP_KV)), [plan.unit]: now.toISOString() };
  await env.APP_KV.put(LIFTED_KEY, JSON.stringify(lifted));
  await env.APP_KV.put(SUSPENDED_KEY, JSON.stringify(rest));
  await env.DB.batch([auditStatement(env.DB, actor, "merge-unit-resumed", plan.unit.split("/")[0]!, null, { unit: plan.unit, reason, was: plan.suspension })]);
  return { ok: true, summary: `Lifted the suspension of ${plan.unit}. The tick may merge its pull requests unattended again; a new rollback suspends it again.` };
}

/** The evidence from D1. Reads only. */
export async function readUnitEvidence(env: Env, now: Date): Promise<{ approvals: ApprovalEvidence[]; rollbacks: RollbackEvidence[] }> {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const approvals = await env.DB.prepare(
    `SELECT namespace, path_class, status, close_reason, closed_at FROM pr_approvals WHERE approved_at >= ?1 AND namespace IS NOT NULL ORDER BY id LIMIT 2000`
  )
    .bind(since)
    .all<ApprovalEvidence>();
  const rolled = await env.DB.prepare(
    `SELECT namespace, repo, pr, head_sha, run_id, run_at FROM deploy_outcomes WHERE outcome IN ('rolled_back', 'rollback_failed') AND run_at >= ?1 ORDER BY run_at LIMIT 50`
  )
    .bind(since)
    .all<{ namespace: string; repo: string; pr: number | null; head_sha: string; run_id: number; run_at: string }>();
  const rollbacks: RollbackEvidence[] = [];
  for (const r of rolled.results ?? []) {
    let merged_by: RollbackEvidence["merged_by"] = "unknown";
    let path_class: string | null = null;
    if (r.pr !== null) {
      // The tick's own record of an unattended merge carries the unit since PR 9.
      const auto = await env.DB.prepare(
        `SELECT params FROM audit_log WHERE action = 'auto-merged' AND namespace = ?1 AND json_extract(params, '$.repo') = ?2 AND json_extract(params, '$.pr') = ?3 ORDER BY id DESC LIMIT 1`
      )
        .bind(r.namespace, r.repo, r.pr)
        .first<{ params: string }>();
      if (auto) {
        merged_by = "tick";
        path_class = ((JSON.parse(auto.params) as { path_class?: unknown }).path_class as string | undefined) ?? null;
      } else {
        const approved = await env.DB.prepare(`SELECT path_class FROM pr_approvals WHERE repo = ?1 AND pr = ?2 AND status = 'merged' ORDER BY id DESC LIMIT 1`)
          .bind(r.repo, r.pr)
          .first<{ path_class: string | null }>();
        if (approved) {
          merged_by = "approval";
          path_class = approved.path_class;
        }
      }
    }
    rollbacks.push({ ...r, kind: "rollback", merged_by, path_class });
  }
  // The reverts of pull requests the tick merged (src/merge-safety.ts): the audit row
  // carries the unit, so a revert places itself.
  const reverted = await env.DB.prepare(
    `SELECT namespace, params FROM audit_log WHERE action = 'auto-merge-reverted' AND at >= ?1 ORDER BY id DESC LIMIT 50`
  )
    .bind(since.slice(0, 19).replace("T", " "))
    .all<{ namespace: string; params: string }>();
  for (const row of reverted.results ?? []) {
    let p: { repo: string; pr: number; reverted_by: number; head_sha?: string | null; path_class?: string | null; merged_at: string };
    try {
      p = JSON.parse(row.params);
    } catch (err) {
      // One malformed row must not fail the step that suspends units.
      logEvent("error", "MERGE_UNITS", { message: `MERGE_UNITS skipped an unreadable auto-merge-reverted row: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    rollbacks.push({
      kind: "revert",
      reverted_by: p.reverted_by,
      namespace: row.namespace,
      repo: p.repo,
      pr: p.pr,
      head_sha: p.head_sha ?? "0".repeat(40),
      run_id: 0,
      run_at: p.merged_at,
      merged_by: "tick",
      path_class: p.path_class ?? null,
    });
  }
  return { approvals: approvals.results ?? [], rollbacks };
}

export interface UnitsTickReport {
  ran: boolean;
  note: string;
  newly_suspended: string[];
}

/** One pass: judge the units, store the report, and suspend a unit a rollback hit. */
export async function unitsTick(env: Env, now: Date, read: typeof readUnitEvidence = readUnitEvidence): Promise<UnitsTickReport> {
  const before = await readSuspended(env.APP_KV);
  const lifted = await readLifted(env.APP_KV);
  const evidence = await read(env, now);
  const report = judgeUnits(evidence.approvals, evidence.rollbacks, before, now, lifted);
  const added = report.suspended.filter((s) => !before.some((b) => b.unit === s.unit));
  if (added.length) {
    await env.APP_KV.put(SUSPENDED_KEY, JSON.stringify(report.suspended));
    await env.DB.batch(added.map((s) => auditStatement(env.DB, "capsid:merge-units", "merge-unit-suspended", s.unit.split("/")[0]!, null, s)));
  }
  const previous = await env.APP_KV.get(REPORT_KEY);
  const stable = (r: UnitsReport) => JSON.stringify({ ...r, generated: "" });
  let changed = true;
  try {
    changed = !previous || stable(JSON.parse(previous) as UnitsReport) !== stable(report);
  } catch {
    // An unreadable report is replaced.
  }
  if (changed) await env.APP_KV.put(REPORT_KEY, JSON.stringify(report));
  if (!added.length && !changed) return { ran: false, note: "no change", newly_suspended: [] };
  return {
    ran: true,
    note: `${report.proposals.length} proposal(s), ${report.suspended.length} unit(s) suspended${added.length ? `, newly: ${added.map((s) => s.unit).join(", ")}` : ""}${report.unplaced.length ? `; ${report.unplaced.length} rollback(s) with no known unit` : ""}`,
    newly_suspended: added.map((s) => s.unit),
  };
}

/** The proposals and suspensions as inbox items, per namespace. */
export async function unitInboxItems(kv: KVNamespace): Promise<Array<{ namespace: string; item: InboxItem }>> {
  const raw = await kv.get(REPORT_KEY).catch(() => null);
  if (!raw) return [];
  let report: UnitsReport;
  try {
    report = JSON.parse(raw) as UnitsReport;
  } catch {
    return [];
  }
  const out: Array<{ namespace: string; item: InboxItem }> = [];
  for (const s of report.suspended ?? []) {
    out.push({ namespace: s.unit.split("/")[0]!, item: { title: `${s.unit.replace("/", " ")} is suspended from auto: ${s.reason}`, kind: "proposal", link: null, since: s.since } });
  }
  for (const p of report.proposals ?? []) out.push({ namespace: p.unit.split("/")[0]!, item: { title: p.title, kind: "proposal", link: null, since: report.generated } });
  return out;
}
