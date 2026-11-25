// Claims apart from verified outcomes (0023), as stored: JSON columns stay JSON text and NULL stays null (not zero).
// Returned by capsid_admin_read_claims and GET /portal/api/claims from the same readers (src/job-claims-read.ts).

export type ClaimsAgreement = "agree" | "disagree" | "unclaimed" | "unchecked";

export interface ClaimsFilter {
  namespace: string | null;
  agent: string | null;
  // ISO 8601, inclusive lower and exclusive upper bound on recorded_at (claims, evaluations) or at (touches).
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
  // Null when no touch carried a wait: unmeasured is not zero.
  waits: number;
  waited_ms_total: number | null;
  waited_ms_median: number | null;
}

export interface ClaimsGroup {
  agent: string | null;
  namespace: string;
  jobs: number;
  claims: number;
  evaluations: Record<string, ClaimsAgreementCounts>;
  touches: ClaimsTouchSummary;
}

// One ended wait. gate_class is a class of capsid/policy/gates.md (compound commands joined with "+"),
// "needs_human" when no class matched or no command, "unreadable_gate" when the detail was not the writer's JSON.
export interface ClaimsWaitRow {
  namespace: string;
  gate_class: string;
  ended_by: string;
  waits: number;
  waited_ms_total: number;
  waited_ms_median: number;
}

// Usage reported in claim.usage, summed over claims that carried any; null when none did, never 0.
export interface ClaimsUsageTotals {
  rows: number;
  cost_usd: number | null;
  active_seconds: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
}

export interface ClaimsUsageRow extends ClaimsUsageTotals {
  namespace: string;
}

export interface ClaimsAggregate {
  filter: ClaimsFilter;
  groups: ClaimsGroup[];
  waits: ClaimsWaitRow[];
  usage: ClaimsUsageRow[];
  // Each bounded read that hit its bound, by name; empty means the answer is whole.
  truncated: string[];
}

export interface JobClaimRow {
  id: number;
  job_id: string;
  action: "complete" | "fail" | "block";
  agent: string;
  namespace: string;
  raw: string;
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
  outcome: Record<string, unknown> | null;
  claims: JobClaimRow[];
  evaluations: JobEvaluationRow[];
  touches: JobTouchRow[];
  limit: number;
  truncated: string[];
}

// GET /portal/api/claims?namespace=&agent=&since=&until= -> PortalClaimsAggregate; ?job=<id> -> PortalClaimsJob
// (404 JSON for no such job). A since or until that is not an ISO time is a text/plain 400.
export interface PortalClaimsAggregate extends ClaimsAggregate {
  generated: string;
}

export interface PortalClaimsJob extends ClaimsJob {
  generated: string;
}
