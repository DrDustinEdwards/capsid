import type { Env } from "./env";
import { IMPROVE_ACTOR } from "./improve-state";
import { auditStatement } from "./store-guards";
import {
  attribute,
  nextStatus,
  type Evaluation,
  type RunSignal,
  type SkillStatus,
  type Transition,
} from "./skills-lifecycle";

// The half of the skill lifecycle that touches rows; the rules in ./skills-lifecycle
// are pure.

// At most three, so the offered-but-not-used rate that judges the recommend step
// still means something.
export const MAX_OFFERED = 3;

// How many failure notes ride along with each offered skill.
export const FAILURE_NOTES_PER_SKILL = 2;

export interface OfferedSkill {
  id: string;
  title: string;
  status: SkillStatus;
  version: number;
  trigger_condition: string | null;
  body_ref: string;
  // The most recent failures recorded against this skill, newest first.
  recent_failures: Array<{ note: string; source_kind: string; source_id: string; created_at: string }>;
}

/**
 * The skills worth offering for one piece of work.
 *
 * Candidate and live only: a retired skill is kept so it is not regenerated, not to
 * be offered. Matched on trigger_condition through FTS; a skill with none is never
 * offered.
 */
export async function offerSkills(env: Env, namespace: string, work: string): Promise<OfferedSkill[]> {
  const terms = ftsQuery(work);
  if (!terms) return [];

  // The FTS index covers documents, and a skill's prose lives at
  // improve/skills/<id>.md, so the match runs there and resolves back to the row.
  const matched = await env.DB.prepare(
    `SELECT s.id, s.title, s.status, s.version, s.trigger_condition, s.body_ref
     FROM improve_skills s
     JOIN documents d ON d.path = s.body_ref AND d.namespace = 'capsid'
     JOIN documents_fts f ON f.rowid = d.id
     WHERE f.documents_fts MATCH ?1
       AND s.status IN ('candidate', 'live')
       AND s.trigger_condition IS NOT NULL
       AND (s.namespaces IS NULL OR s.namespaces LIKE ?2)
     ORDER BY bm25(documents_fts)
     LIMIT ?3`
  )
    .bind(terms, `%"${namespace}"%`, MAX_OFFERED)
    .all<{ id: string; title: string; status: string; version: number; trigger_condition: string | null; body_ref: string }>();

  const rows = matched.results ?? [];
  const out: OfferedSkill[] = [];
  for (const row of rows) {
    const failures = await env.DB.prepare(
      `SELECT note, source_kind, source_id, created_at FROM skill_failures
       WHERE skill = ?1 ORDER BY created_at DESC LIMIT ?2`
    )
      .bind(row.id, FAILURE_NOTES_PER_SKILL)
      .all<{ note: string; source_kind: string; source_id: string; created_at: string }>();
    out.push({
      id: row.id,
      title: row.title,
      status: row.status as SkillStatus,
      version: row.version,
      trigger_condition: row.trigger_condition,
      body_ref: row.body_ref,
      recent_failures: failures.results ?? [],
    });
  }
  return out;
}

// Reduced to bare words joined by OR, so FTS5 operators in free prose (a quote, a
// NEAR) cannot change what the query means.
export function ftsQuery(work: string): string | null {
  const words = work
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .slice(0, 24);
  return words.length > 0 ? words.join(" OR ") : null;
}

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

/** One note per skill that was in use when a run failed or was reverted. */
export function failureNoteStatements(
  db: D1Database,
  namespace: string,
  source: { kind: "attempt" | "job"; id: string },
  skillIds: readonly string[],
  note: string
): D1PreparedStatement[] {
  return skillIds.map((skill) =>
    db
      .prepare(
        `INSERT INTO skill_failures (skill, namespace, source_kind, source_id, note)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
      .bind(skill, namespace, source.kind, source.id, note.slice(0, 2000))
  );
}

/**
 * Apply what ./skills-lifecycle decided, as a keyed UPDATE so a status that moved
 * underneath this read is not overwritten. Returns whether it landed. The audit row
 * is in the same batch and inserts only when the row now holds the new status, so a
 * transition that did not land records nothing.
 */
export async function commitTransition(
  env: Env,
  skill: string,
  from: SkillStatus,
  to: SkillStatus,
  now: Date,
  reason: string
): Promise<boolean> {
  const [moved] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE improve_skills SET status = ?3, retired_at = CASE WHEN ?3 = 'retired' THEN ?4 ELSE retired_at END
       WHERE id = ?1 AND status = ?2 RETURNING id`
    ).bind(skill, from, to, now.toISOString()),
    env.DB.prepare(
      `INSERT INTO audit_log (actor, action, namespace, path, params)
       SELECT ?1, 'skill-status-changed', NULL, NULL, ?2
       WHERE EXISTS (SELECT 1 FROM improve_skills WHERE id = ?3 AND status = ?4)`
    ).bind(IMPROVE_ACTOR, JSON.stringify({ skill, from, to, reason, at: now.toISOString() }), skill, to),
  ]);
  return (moved?.results?.length ?? 0) === 1;
}

/** Every candidate and live skill's transition verdict, from its stored evaluations. */
export async function dueTransitions(env: Env): Promise<Array<{ skill: string; verdict: Transition }>> {
  const skills = await env.DB.prepare(
    "SELECT id, status, version FROM improve_skills WHERE status IN ('candidate', 'live')"
  ).all<{ id: string; status: string; version: number }>();

  const out: Array<{ skill: string; verdict: Transition }> = [];
  for (const skill of skills.results ?? []) {
    const evaluations = await env.DB.prepare(
      `SELECT skill, version, namespace, probe_set_version, delta, runs, verdict, evaluated_at
       FROM skill_evaluations WHERE skill = ?1 AND version = ?2 ORDER BY evaluated_at ASC`
    )
      .bind(skill.id, skill.version)
      .all<Evaluation>();
    out.push({
      skill: skill.id,
      verdict: nextStatus(skill.status as SkillStatus, skill.version, evaluations.results ?? []),
    });
  }
  return out;
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
