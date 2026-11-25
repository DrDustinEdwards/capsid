import { ROUTING_RULES, ROUTING_RULES_VERSION, TRIAL_ARMS } from "./model-routing";
import {
  MIN_SAMPLE,
  RATE_FLOOR,
  RATE_GAIN,
  cellsOf,
  modelAlias,
  proposeRuleChanges,
  trialStatus,
  type Cell,
  type OutcomeFact,
  type Proposal,
  type TrialStatus,
} from "./model-evidence";
import { DAY_MS } from "./time";
import { plural } from "@drdustinedwards/site-helpers/text";

// Per kind and model: merged with green CI and not undone since, plus corrections spent, from job_outcomes
// (capsid/research/design-model-routing.md). A merge is a weak label alone (Peralta et al., MSR 2026), so a reverted
// PR or rolled-back deploy does not count as held. Proposes rule changes, applies none.

const LEARNING_WINDOW_DAYS = 90;
// One bounded read; a window with more outcomes says so rather than present a partial table as whole.
const LEARNING_ROWS_MAX = 5000;

export interface ModelLearning {
  generated: string;
  window_days: number;
  outcomes_read: number;
  truncated: boolean;
  min_sample: number;
  rate_floor: number;
  rate_gain: number;
  rules_version: number;
  rules: ReadonlyArray<{ when: Record<string, string>; model: string; effort: string }>;
  trial_arms: ReadonlyArray<{ kind: string; model: string; percent: number }>;
  cells: Cell[];
  proposals: Proposal[];
  trials: TrialStatus[];
  note: string;
}

interface Row {
  kind: string | null;
  model: string | null;
  model_actual: string | null;
  prs_merged: number | null;
  ci_green: number | null;
  corrections: number | null;
  undone: number;
}

// Learned under the model Capsid chose. model_actual is the session's report and never moves an outcome
// into another cell; one reporting a different model is left out. opusplan runs as Opus and Sonnet.
function onChosenModel(r: Row): boolean {
  const actual = modelAlias(r.model_actual);
  if (actual === null || r.model === null) return true;
  return r.model === "opusplan"
    ? actual === "opus" || actual === "sonnet" || actual === "opusplan"
    : actual === r.model;
}

export async function readModelLearning(db: D1Database, now: Date): Promise<ModelLearning> {
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT o.job_kind AS kind, o.model_chosen AS model, o.model_actual AS model_actual, o.prs_merged AS prs_merged, o.ci_green AS ci_green,
              j.corrections_count AS corrections,
              (EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'job-pr-reverted' AND json_extract(a.params, '$.job_id') = o.job_id)
               OR EXISTS (SELECT 1 FROM job_outcome_prs p JOIN deploy_outcomes d
                            ON lower(p.pr_url) = lower('https://github.com/' || d.repo || '/pull/' || d.pr)
                          WHERE p.job_id = o.job_id AND d.outcome IN ('rolled_back', 'rollback_failed'))) AS undone
       FROM job_outcomes o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.job_kind IS NOT NULL AND o.recorded_at >= ?1
       ORDER BY o.recorded_at DESC LIMIT ?2`,
    )
    .bind(since, LEARNING_ROWS_MAX + 1)
    .all<Row>();
  const rows = results ?? [];
  const truncated = rows.length > LEARNING_ROWS_MAX;
  const read = truncated ? rows.slice(0, LEARNING_ROWS_MAX) : rows;
  const facts: OutcomeFact[] = read.filter(onChosenModel).map((r) => ({
    kind: r.kind,
    model: r.model,
    prs_merged: r.prs_merged,
    ci_green: r.ci_green,
    corrections: r.corrections,
    undone: r.undone === 1,
  }));
  const mismatched = read.length - facts.length;
  const cells = cellsOf(facts);
  const proposals = proposeRuleChanges(cells);
  const enough = cells.filter((c) => c.enough).length;
  return {
    generated: now.toISOString(),
    window_days: LEARNING_WINDOW_DAYS,
    outcomes_read: read.length,
    truncated,
    min_sample: MIN_SAMPLE,
    rate_floor: RATE_FLOOR,
    rate_gain: RATE_GAIN,
    rules_version: ROUTING_RULES_VERSION,
    rules: ROUTING_RULES.map((r) => ({
      when: Object.fromEntries(Object.entries(r.when)) as Record<string, string>,
      model: r.model,
      effort: r.effort,
    })),
    trial_arms: TRIAL_ARMS.map((a) => ({ kind: a.kind, model: a.model, percent: a.percent })),
    cells,
    proposals,
    trials: trialStatus(cells),
    note:
      read.length === 0
        ? "No routed outcome in the window yet: outcomes written before migration 0032 carry no kind or model. Nothing is proposed from no evidence."
        : `${cells.length} kind and model cells, ${enough} with at least ${MIN_SAMPLE} outcomes; only those are acted on. ${plural(proposals.length, "proposed change")}, none applied: the seat approves each rule edit.${mismatched ? ` ${mismatched} outcome${mismatched === 1 ? " was" : "s were"} left out because the session reported a model other than the one chosen.` : ""}${truncated ? ` The window holds more than ${LEARNING_ROWS_MAX} outcomes, so this is the newest ${LEARNING_ROWS_MAX}.` : ""}`,
  };
}
