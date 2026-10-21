// ---------------------------------------------------------------------------
// Claims apart from verified outcomes (migrations/0023_job_claims.sql). The
// `capsid_admin_read_claims` tool and GET /portal/api/claims return these, from the same readers
// (src/job-claims-read.ts). Every column is as stored: JSON columns stay JSON text,
// and NULL stays null, because NULL is not zero.

export type ClaimsAgreement = "agree" | "disagree" | "unclaimed" | "unchecked";

export interface ClaimsFilter {
  namespace: string | null;
  // The claiming agent's actor string, e.g. agent:sample-driver.
  agent: string | null;
  // ISO 8601, inclusive lower bound and exclusive upper bound on each row's own time
  // (recorded_at for claims and evaluations, at for touches).
  since: string | null;
  until: string | null;
}

export interface ClaimsAgreementCounts {
  agree: number;
  disagree: number;
  unclaimed: number;
  unchecked: number;
}

interface ClaimsTouchSummary {
  count: number;
  by_kind: Record<string, number>;
  by_actor_kind: Record<string, number>;
  // Over the touches that carry a wait. Null when none does: no wait was measured,
  // which is not a wait of zero.
  waits: number;
  waited_ms_total: number | null;
  waited_ms_median: number | null;
}

export interface ClaimsGroup {
  // Null for touches on a job no agent has made a claim on yet.
  agent: string | null;
  namespace: string;
  // Distinct jobs with a claim, and claim rows.
  jobs: number;
  claims: number;
  // Per evaluation name (pr_merged, prs_opened, ...), the claim-to-verified agreement.
  evaluations: Record<string, ClaimsAgreementCounts>;
  touches: ClaimsTouchSummary;
}

// One ended wait: a touch with a waited_ms, tied to the gate it ended. gate_class is a
// class of capsid/policy/gates.md (compound commands joined with "+"), "needs_human"
// when the gate's command matched none or recorded no command, or "unreadable_gate"
// when the gate row's detail was not the JSON the writer produces.
export interface ClaimsWaitRow {
  namespace: string;
  gate_class: string;
  // Who ended the wait: human, policy, seat and so on (job_touches.actor_kind).
  ended_by: string;
  waits: number;
  waited_ms_total: number;
  waited_ms_median: number;
}

// Cost, tokens and active time for one source, summed over the rows that carried it.
// Every figure is null when no row carried it, never 0.
export interface ClaimsUsageTotals {
  // Jobs (telemetry) or claims (reported) that carried any usage at all.
  rows: number;
  cost_usd: number | null;
  active_seconds: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
}

// Per namespace, the two sources side by side and never added together: telemetry from
// job_outcomes (src/job-outcomes.ts readJobUsage) and what the agent reported in
// claim.usage. A job can appear in both, so a sum across them would count it twice.
export interface ClaimsUsageRow {
  namespace: string;
  telemetry: ClaimsUsageTotals;
  reported: ClaimsUsageTotals;
}

export interface ClaimsAggregate {
  filter: ClaimsFilter;
  groups: ClaimsGroup[];
  // Ended waits by namespace, gate class and who ended them, longest total first.
  waits: ClaimsWaitRow[];
  usage: ClaimsUsageRow[];
  // Each bounded read that hit its bound, by name. Empty means the answer is whole.
  truncated: string[];
}

export interface JobClaimRow {
  id: number;
  job_id: string;
  action: "complete" | "fail" | "block";
  agent: string;
  namespace: string;
  raw: string;
  prs_opened_urls: string | null;
  prs_merged_urls: string | null;
  prs_opened: number | null;
  prs_merged: number | null;
  commits: number | null;
  files_changed: number | null;
  tests_added: number | null;
  tests_run: number | null;
  tests_passed: number | null;
  tests_failed: number | null;
  tests_result: string | null;
  deploy_state: string | null;
  files_touched: string | null;
  model_id: string | null;
  client_name: string | null;
  client_version: string | null;
  permission_mode: string | null;
  capsid_sha: string | null;
  recorded_at: string;
}

export interface JobEvaluationRow {
  id: number;
  job_id: string;
  claim_id: number | null;
  name: string;
  score_value: number | null;
  score_label: "pass" | "fail" | "unknown";
  claimed: string | null;
  verified: string | null;
  agreement: ClaimsAgreement;
  evaluator: "worker" | "model" | "human";
  evaluator_id: string;
  explanation: string | null;
  recorded_at: string;
}

export interface JobTouchRow {
  id: number;
  job_id: string;
  namespace: string;
  kind: string;
  actor: string;
  actor_kind: string;
  waited_ms: number | null;
  detail: string | null;
  at: string;
}

export interface ClaimsJob {
  job: { id: string; namespace: string; title: string; status: string; claimed_by: string | null };
  // The job_outcomes row as stored, or null when the job has not ended.
  outcome: Record<string, unknown> | null;
  // Oldest first, each at most `limit`.
  claims: JobClaimRow[];
  evaluations: JobEvaluationRow[];
  touches: JobTouchRow[];
  limit: number;
  truncated: string[];
}

// GET /portal/api/claims?namespace=&agent=&since=&until=  -> PortalClaimsAggregate
// GET /portal/api/claims?job=<id>                         -> PortalClaimsJob (404 JSON for no such job)
// A since or until that is not an ISO time is a text/plain 400.
export interface PortalClaimsAggregate extends ClaimsAggregate {
  generated: string;
}

export interface PortalClaimsJob extends ClaimsJob {
  generated: string;
}
