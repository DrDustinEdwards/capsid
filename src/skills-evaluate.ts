import type { Env } from "./env";
import {
  acceptEdit,
  shouldProposeMerge,
  verdictFor,
  withinEditBound,
  type EditOp,
  type SkillStatus,
} from "./skills-lifecycle";
import { commitTransition, dueTransitions } from "./skills-records";
import { signalForRow, type JobOutcomeRow } from "./job-outcomes";
import { IMPROVE_ACTOR } from "./improve-state";
import { auditStatement } from "./store-guards";
import { OFFER_ACTION } from "./job-skill-offers";

// The evaluation cycle writes evaluations from verified job outcomes, then applies
// the transitions ./skills-lifecycle decides from them, unless transitions are held.
// It dispatches no probe (capsid/decisions.md, option C).

export const CADENCE_KEY = "skills:evaluate:cadence-days";
export const LAST_CYCLE_KEY = "skills:evaluate:last";

// Biweekly by default, KV-configurable. A status moves up to a fortnight after the
// evidence that decides it lands.
export const DEFAULT_CADENCE_DAYS = 14;

// The floor: zero or less would run the cycle on every tick, so an unusable value
// falls back to the default.
export const MIN_CADENCE_DAYS = 1;

export async function cadenceDays(env: Env): Promise<number> {
  try {
    const raw = await env.APP_KV.get(CADENCE_KEY);
    if (raw === null) return DEFAULT_CADENCE_DAYS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < MIN_CADENCE_DAYS) return DEFAULT_CADENCE_DAYS;
    return Math.floor(parsed);
  } catch {
    // An unreadable store means the default.
    return DEFAULT_CADENCE_DAYS;
  }
}

export type DueVerdict = { due: true; reason: string } | { due: false; reason: string };

export function cycleDue(lastIso: string | null, days: number, now: Date): DueVerdict {
  if (!lastIso) return { due: true, reason: "no evaluation cycle has run yet." };
  const last = Date.parse(lastIso);
  if (Number.isNaN(last)) {
    // A corrupt stamp runs the cycle rather than blocking it forever.
    return { due: true, reason: `the last-cycle stamp '${lastIso}' does not parse, so the cycle runs.` };
  }
  const elapsedDays = (now.getTime() - last) / 86_400_000;
  return elapsedDays >= days
    ? { due: true, reason: `${elapsedDays.toFixed(1)} days since the last cycle, cadence is ${days}.` }
    : { due: false, reason: `${elapsedDays.toFixed(1)} of ${days} days since the last cycle.` };
}

// Status changes are HELD unless this key reads "apply". During the observation
// window evaluations are recorded and statuses must not move (Dustin, 2026-09-26), so
// an unset key, any other value and an unreadable KV all mean hold. The seat turns
// application on with improve_run action "skill_transitions", value "apply".
export const TRANSITIONS_KEY = "skills:transitions";
export type TransitionMode = "hold" | "apply";

export async function transitionMode(env: Env): Promise<TransitionMode> {
  try {
    return (await env.APP_KV.get(TRANSITIONS_KEY)) === "apply" ? "apply" : "hold";
  } catch (err) {
    console.error(`SKILL_TRANSITIONS_UNREADABLE: ${err instanceof Error ? err.message : String(err)}; holding`);
    return "hold";
  }
}

// The evaluation measure (Dustin, 2026-09-26): among runs offered a skill at its
// current version, the verified success rate of those that USED it minus that of
// those that did not. Not a controlled comparison: a session chooses when to use a
// skill, so the two groups differ in more than the skill. Runs the Worker could not
// verify count in neither group, as signalFor already treats them.
export const EVALUATION_MEASURE = "job-outcomes-used-vs-offered-unused-v1";

// No evaluation before this many verified used runs since the last one.
export const MIN_USED_RUNS = 5;

export interface EvaluationWritten {
  skill: string;
  version: number;
  written: boolean;
  reason: string;
}

// sqlite's datetime('now') and an ISO string, compared as instants.
const instant = (at: string): number => Date.parse(at.includes("T") ? at : `${at.replace(" ", "T")}Z`);

/** One evaluation per candidate or live skill that has enough new verified runs. */
export async function writeEvaluations(env: Env): Promise<EvaluationWritten[]> {
  // The statement dueTransitions runs, so both read the same set of skills.
  const skills = await env.DB.prepare("SELECT id, status, version FROM improve_skills WHERE status IN ('candidate', 'live')").all<{
    id: string;
    version: number;
  }>();
  const out: EvaluationWritten[] = [];
  for (const skill of skills.results ?? []) {
    const last = await env.DB.prepare(
      "SELECT evaluated_at FROM skill_evaluations WHERE skill = ?1 AND version = ?2 AND probe_set_version = ?3 ORDER BY evaluated_at DESC LIMIT 1"
    )
      .bind(skill.id, skill.version, EVALUATION_MEASURE)
      .first<{ evaluated_at: string }>();
    const since = last ? instant(last.evaluated_at) : -Infinity;

    // The jobs offered this skill at this version, from the Worker's offer records.
    const offers = await env.DB.prepare("SELECT params FROM audit_log WHERE action = ?1 AND params LIKE ?2")
      .bind(OFFER_ACTION, `%"${skill.id}"%`)
      .all<{ params: string }>();
    const jobIds: string[] = [];
    for (const row of offers.results ?? []) {
      const params = JSON.parse(row.params) as { job_id?: string; skills?: Array<{ id: string; version: number }> };
      if (params.job_id && params.skills?.some((s) => s.id === skill.id && s.version === skill.version)) jobIds.push(params.job_id);
    }

    let used = 0;
    let usedWins = 0;
    let unused = 0;
    let unusedWins = 0;
    for (const jobId of jobIds) {
      const o = await env.DB.prepare(
        "SELECT prs_opened, prs_merged, ci_green, verified, skill_ids_used, recorded_at FROM job_outcomes WHERE job_id = ?1"
      )
        .bind(jobId)
        .first<Pick<JobOutcomeRow, "prs_opened" | "prs_merged" | "ci_green" | "verified" | "skill_ids_used" | "recorded_at">>();
      if (!o || instant(o.recorded_at) <= since) continue;
      const signal = signalForRow(o);
      if (signal !== "verified-success" && signal !== "verified-failure") continue;
      const win = signal === "verified-success" ? 1 : 0;
      const usedIds = o.skill_ids_used ? (JSON.parse(o.skill_ids_used) as string[]) : [];
      if (usedIds.includes(skill.id)) {
        used++;
        usedWins += win;
      } else {
        unused++;
        unusedWins += win;
      }
    }

    if (used < MIN_USED_RUNS) {
      out.push({
        skill: skill.id,
        version: skill.version,
        written: false,
        reason: `${used} verified used run(s) since the last evaluation; an evaluation needs ${MIN_USED_RUNS}.`,
      });
      continue;
    }
    if (unused === 0) {
      out.push({
        skill: skill.id,
        version: skill.version,
        written: false,
        reason: `${used} verified used runs and no verified run that was offered the skill and did not use it, so there is nothing to compare against.`,
      });
      continue;
    }
    const delta = usedWins / used - unusedWins / unused;
    await env.DB.batch([
      evaluationStatement(env.DB, {
        skill: skill.id,
        version: skill.version,
        namespace: "*",
        probeSetVersion: EVALUATION_MEASURE,
        delta,
        runs: used + unused,
      }),
      auditStatement(env.DB, IMPROVE_ACTOR, "skill-evaluated", "capsid", null, {
        skill: skill.id,
        version: skill.version,
        measure: EVALUATION_MEASURE,
        used_runs: used,
        used_wins: usedWins,
        unused_runs: unused,
        unused_wins: unusedWins,
        delta,
      }),
    ]);
    out.push({
      skill: skill.id,
      version: skill.version,
      written: true,
      reason: `delta ${delta.toFixed(3)} from ${used} used and ${unused} unused verified runs.`,
    });
  }
  return out;
}

export interface CycleReport {
  ran: boolean;
  note: string;
  evaluations: EvaluationWritten[];
  mode: TransitionMode;
  transitions: Array<{ skill: string; from: SkillStatus; to: SkillStatus; reason: string }>;
  // Transitions the evaluations decided and the hold kept from being applied.
  held: Array<{ skill: string; from: SkillStatus; to: SkillStatus; reason: string }>;
}

/** One pass: commit and audit whatever the stored evaluations already decide. */
export async function runEvaluationCycle(env: Env, now: Date): Promise<CycleReport> {
  const days = await cadenceDays(env);
  const last = await env.APP_KV.get(LAST_CYCLE_KEY).catch(() => null);
  const verdict = cycleDue(last, days, now);
  const mode = await transitionMode(env);
  if (!verdict.due) return { ran: false, note: verdict.reason, evaluations: [], mode, transitions: [], held: [] };

  const evaluations = await writeEvaluations(env);
  const transitions: CycleReport["transitions"] = [];
  const held: CycleReport["held"] = [];
  for (const { skill, verdict: decision } of await dueTransitions(env)) {
    if (!decision.change) continue;
    if (mode === "hold") {
      held.push({ skill, from: decision.from, to: decision.to, reason: decision.reason });
      continue;
    }
    const landed = await commitTransition(env, skill, decision.from, decision.to, now, decision.reason);
    if (!landed) continue;
    transitions.push({ skill, from: decision.from, to: decision.to, reason: decision.reason });
  }

  await env.APP_KV.put(LAST_CYCLE_KEY, now.toISOString());
  return {
    ran: true,
    note: `${verdict.reason} ${evaluations.filter((e) => e.written).length} evaluation(s) written, ${transitions.length} transition(s) applied, ${held.length} held.`,
    evaluations,
    mode,
    transitions,
    held,
  };
}

/** Record one measured evaluation. The verdict is derived here and then stored, so a
 *  later change to the threshold cannot restate old rows as something they were not. */
export function evaluationStatement(
  db: D1Database,
  row: { skill: string; version: number; namespace: string; probeSetVersion: string; delta: number; runs: number }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO skill_evaluations (skill, version, namespace, probe_set_version, delta, runs, verdict)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(row.skill, row.version, row.namespace, row.probeSetVersion, row.delta, row.runs, verdictFor(row.delta));
}

// An optimizer proposes operations on a skill's instructions. The bound is checked
// before anything is measured, so an out-of-bounds edit costs no CI.

export type ProposalVerdict =
  | { accepted: false; reason: string; recorded: D1PreparedStatement }
  | { accepted: true; reason: string; recorded: D1PreparedStatement[] };

/**
 * Whether a proposed edit is taken, and the rows that record the answer either way.
 *
 * Both outcomes are recorded: a rejected edit is what stops the next optimizer
 * proposing the same thing.
 */
export function judgeEdit(
  db: D1Database,
  skill: { id: string; version: number; l2: string },
  ops: readonly EditOp[],
  measured: { deltaBefore: number; deltaAfter: number } | null
): ProposalVerdict {
  const to = skill.version + 1;
  const row = (accepted: boolean, reason: string) =>
    db
      .prepare(
        `INSERT INTO skill_edits (skill, from_version, to_version, ops, accepted, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(skill.id, skill.version, to, JSON.stringify(ops), accepted ? 1 : 0, reason);

  const bound = withinEditBound(skill.l2, ops);
  if (!bound.ok) return { accepted: false, reason: bound.reason, recorded: row(false, bound.reason) };

  if (!measured) {
    const reason = "the edited version was not measured against the probe set, and an unmeasured edit is not accepted.";
    return { accepted: false, reason, recorded: row(false, reason) };
  }

  const verdict = acceptEdit(measured.deltaBefore, measured.deltaAfter);
  if (!verdict.accepted) return { accepted: false, reason: verdict.reason, recorded: row(false, verdict.reason) };

  // The version bump resets the skill's evaluation evidence.
  return {
    accepted: true,
    reason: verdict.reason,
    recorded: [
      row(true, verdict.reason),
      db.prepare("UPDATE improve_skills SET version = ?2 WHERE id = ?1 AND version = ?3").bind(skill.id, to, skill.version),
    ],
  };
}

/** What the next optimizer run is shown: this skill's refused proposals, newest first. */
export async function rejectedEdits(
  env: Env,
  skill: string,
  limit = 5
): Promise<Array<{ from_version: number; ops: string; reason: string; evaluated_at: string }>> {
  const rows = await env.DB.prepare(
    `SELECT from_version, ops, reason, evaluated_at FROM skill_edits
     WHERE skill = ?1 AND accepted = 0 ORDER BY evaluated_at DESC LIMIT ?2`
  )
    .bind(skill, limit)
    .all<{ from_version: number; ops: string; reason: string; evaluated_at: string }>();
  return rows.results ?? [];
}

// Two live skills saying nearly the same thing about the same trigger are a
// duplicate. A merged result starts as a candidate: nothing has evaluated it.

export interface MergeProposal {
  a: string;
  b: string;
  reason: string;
}

/** Every pair worth proposing, compared pairwise over live skills only. */
export async function mergeProposals(env: Env): Promise<MergeProposal[]> {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.status, s.trigger_condition, d.body
     FROM improve_skills s
     LEFT JOIN documents d ON d.path = s.body_ref AND d.namespace = 'capsid'
     WHERE s.status = 'live' AND s.trigger_condition IS NOT NULL`
  ).all<{ id: string; status: string; trigger_condition: string; body: string | null }>();

  const live = rows.results ?? [];
  const out: MergeProposal[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const verdict = shouldProposeMerge(
        { status: "live", trigger: live[i].trigger_condition, body: live[i].body ?? "" },
        { status: "live", trigger: live[j].trigger_condition, body: live[j].body ?? "" }
      );
      if (verdict.merge) out.push({ a: live[i].id, b: live[j].id, reason: verdict.reason });
    }
  }
  return out;
}
