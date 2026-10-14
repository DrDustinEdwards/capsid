import type { Env } from "./env";
import { acceptEdit, shouldProposeMerge, withinEditBound, type EditOp, type SkillStatus } from "./skills-lifecycle";

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
