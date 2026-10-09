import { MIN_SAMPLE, RATE_FLOOR, RATE_GAIN, ROUTING_RULES, ROUTING_RULES_VERSION, cellsOf, proposeRuleChanges, type Cell, type OutcomeFact, type Proposal } from "./model-routing";

// WHAT THE ROUTING LEARNS (capsid/research/design-model-routing.md): per kind and model,
// the share of jobs merged with green CI, the corrections spent, and the cost where
// telemetry recorded one, read from job_outcomes. Merge and CI are GitHub's, read at
// complete, not the driver's own account (docs/work-queue.md). The result proposes rule
// changes and applies none: the rules are code and the seat approves each edit.

const LEARNING_WINDOW_DAYS = 90;
// One read, bounded. A window with more outcomes than this says so, never a partial table
// presented as the whole.
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
  cells: Cell[];
  proposals: Proposal[];
  note: string;
}

interface Row {
  kind: string | null;
  model: string | null;
  prs_merged: number | null;
  ci_green: number | null;
  corrections: number | null;
  cost_usd: number | null;
  tokens: number | null;
}

export async function readModelLearning(db: D1Database, now: Date): Promise<ModelLearning> {
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT o.job_kind AS kind, COALESCE(o.model_actual, o.model_chosen) AS model, o.prs_merged AS prs_merged, o.ci_green AS ci_green,
              j.corrections_count AS corrections, o.cost_usd AS cost_usd,
              CASE WHEN o.tokens_input IS NULL AND o.tokens_output IS NULL THEN NULL ELSE COALESCE(o.tokens_input, 0) + COALESCE(o.tokens_output, 0) END AS tokens
       FROM job_outcomes o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.job_kind IS NOT NULL AND o.recorded_at >= ?1
       ORDER BY o.recorded_at DESC LIMIT ?2`
    )
    .bind(since, LEARNING_ROWS_MAX + 1)
    .all<Row>();
  const rows = results ?? [];
  const truncated = rows.length > LEARNING_ROWS_MAX;
  const facts: OutcomeFact[] = (truncated ? rows.slice(0, LEARNING_ROWS_MAX) : rows).map((r) => ({ ...r }));
  const cells = cellsOf(facts);
  const proposals = proposeRuleChanges(cells);
  const enough = cells.filter((c) => c.enough).length;
  return {
    generated: now.toISOString(),
    window_days: LEARNING_WINDOW_DAYS,
    outcomes_read: facts.length,
    truncated,
    min_sample: MIN_SAMPLE,
    rate_floor: RATE_FLOOR,
    rate_gain: RATE_GAIN,
    rules_version: ROUTING_RULES_VERSION,
    rules: ROUTING_RULES.map((r) => ({ when: Object.fromEntries(Object.entries(r.when)) as Record<string, string>, model: r.model, effort: r.effort })),
    cells,
    proposals,
    note:
      facts.length === 0
        ? "No routed outcome in the window yet: outcomes written before migration 0032 carry no kind or model. Nothing is proposed from no evidence."
        : `${cells.length} kind and model cells, ${enough} with at least ${MIN_SAMPLE} outcomes; only those are acted on. ${proposals.length} proposed change${proposals.length === 1 ? "" : "s"}, none applied: the seat approves each rule edit.${truncated ? ` The window holds more than ${LEARNING_ROWS_MAX} outcomes, so this is the newest ${LEARNING_ROWS_MAX}.` : ""}`,
  };
}
