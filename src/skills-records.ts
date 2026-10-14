import type { Env } from "./env";
import { IMPROVE_ACTOR } from "./improve-state";
import { auditStatement } from "./store-guards";
import { attribute, type RunSignal } from "./skills-lifecycle";

// The half of the skill lifecycle that touches rows; the rules in ./skills-lifecycle
// are pure.

export interface CandidateSource {
  kind: "attempt" | "job";
  id: string;
  // For a job: the outcome row's verified counts.
  prsMerged?: number | null;
  ciGreen?: number | null;
  kept?: boolean;
}

export type CreateVerdict = { create: true; reason: string } | { create: false; reason: string };

/**
 * Whether a source has earned a candidate skill.
 *
 * A kept attempt, or a job verified with a merged pull request and green CI. Both
 * bars say the work landed, not that the skill is good, so the result is a candidate.
 */
export function shouldCreateCandidate(source: CandidateSource): CreateVerdict {
  if (source.kind === "attempt") {
    return source.kept
      ? { create: true, reason: `attempt ${source.id} was kept.` }
      : { create: false, reason: `attempt ${source.id} was reverted, so there is nothing to abstract from it.` };
  }
  if (source.prsMerged !== 1 || source.ciGreen !== 1) {
    return {
      create: false,
      reason: `job ${source.id} is not fully verified (prs_merged ${source.prsMerged ?? "null"}, ci_green ${source.ciGreen ?? "null"}); a candidate is written only from work the Worker checked landed.`,
    };
  }
  return { create: true, reason: `job ${source.id} merged one pull request with green CI.` };
}

/**
 * Whether this source has already produced a skill, retired ones included.
 *
 * Retired counts, or a retired skill would be abstracted again from the same source.
 */
export async function alreadyAbstracted(env: Env, source: CandidateSource): Promise<{ skill: string; status: string } | null> {
  // Two spelled-out statements rather than an interpolated column, so the integration
  // suite's query-plan guard can read them.
  const row =
    source.kind === "attempt"
      ? await env.DB.prepare("SELECT id, status FROM improve_skills WHERE source_attempt = ?1 LIMIT 1")
          .bind(source.id)
          .first<{ id: string; status: string }>()
      : await env.DB.prepare("SELECT id, status FROM improve_skills WHERE source_job = ?1 LIMIT 1")
          .bind(source.id)
          .first<{ id: string; status: string }>();
  return row ? { skill: row.id, status: row.status } : null;
}

export interface AttributionInput {
  offered: readonly string[];
  used: readonly string[];
  signal: RunSignal;
}

/**
 * What one finished run does to each skill it was offered: statements only for the
 * skills that move. The only writer of wins and losses. Each credit carries an audit
 * row, so a counter traces back to the run and the reason attribute() gave.
 */
export function attributionStatements(db: D1Database, input: AttributionInput): D1PreparedStatement[] {
  const used = new Set(input.used);
  const statements: D1PreparedStatement[] = [];
  for (const skill of input.offered) {
    const verdict = attribute(used.has(skill), input.signal);
    if (verdict.credit === "none") continue;
    // Spelled out for the query-plan guard, as in alreadyAbstracted.
    statements.push(
      verdict.credit === "win"
        ? db.prepare("UPDATE improve_skills SET wins = wins + 1 WHERE id = ?1").bind(skill)
        : db.prepare("UPDATE improve_skills SET losses = losses + 1 WHERE id = ?1").bind(skill),
      auditStatement(db, IMPROVE_ACTOR, "improve-skill-outcome", "capsid", null, {
        skill_id: skill,
        credit: verdict.credit,
        signal: input.signal,
        reason: verdict.reason,
      })
    );
  }
  return statements;
}
