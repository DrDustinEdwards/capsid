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

// The evaluation cycle applies evaluation evidence: it reads the rows already
// recorded and commits the transitions ./skills-lifecycle decides. It dispatches no
// probe; evidence comes from verified job outcomes and scored improve attempts
// (capsid/decisions.md). The writer that turns a job outcome into a
// skill_evaluations row is not implemented here.

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

export interface CycleReport {
  ran: boolean;
  note: string;
  transitions: Array<{ skill: string; from: SkillStatus; to: SkillStatus; reason: string }>;
}

/** One pass: commit and audit whatever the stored evaluations already decide. */
export async function runEvaluationCycle(env: Env, now: Date): Promise<CycleReport> {
  const days = await cadenceDays(env);
  const last = await env.APP_KV.get(LAST_CYCLE_KEY).catch(() => null);
  const verdict = cycleDue(last, days, now);
  if (!verdict.due) return { ran: false, note: verdict.reason, transitions: [] };

  const transitions: CycleReport["transitions"] = [];
  for (const { skill, verdict: decision } of await dueTransitions(env)) {
    if (!decision.change) continue;
    const landed = await commitTransition(env, skill, decision.from, decision.to, now, decision.reason);
    if (!landed) continue;
    transitions.push({ skill, from: decision.from, to: decision.to, reason: decision.reason });
  }

  await env.APP_KV.put(LAST_CYCLE_KEY, now.toISOString());
  return {
    ran: true,
    note: `${verdict.reason} ${transitions.length} transition(s).`,
    transitions,
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
