// The Watch Floor contract: what GET /portal/api/ops returns
// (capsid/research/design-ops-console.md). Types only, no runtime code, so the
// dashboard app under dashboard/ imports it with `import type` and src/ never imports
// from the app. Changing a field here changes both sides, and both typecheck against it.

export type ProbeState = "ok" | "degraded" | "liveness" | "down";
export type CheckState = "clear" | "finding" | "could-not-run";

export interface SiteProbe {
  namespace: string;
  name: string;
  origin: string;
  health_path: string | null;
  platform: "cloudflare" | "vercel";
  state: ProbeState;
  // The status of the URL the state rests on: the health route, or the root.
  http_status: number | null;
  latency_ms: number | null;
  // Reported by the site's own health route, where it reports one.
  sha: string | null;
  error: string | null;
  checked_at: string;
}

export interface CfDeploy {
  id: string;
  created_on: string;
  // The version serving the largest share of traffic in this deployment.
  version_id: string | null;
  // annotations["workers/message"] and ["workers/triggered_by"], as Cloudflare
  // records them.
  message: string | null;
  triggered_by: string | null;
  author_email: string | null;
}

export interface HourBucket {
  // The hour's start, ISO.
  hour: string;
  requests: number;
  errors: number;
}

// Cloudflare's view of one site. Every state but "ok" is shown as no data, with its
// reason, never as zero.
export type SiteCloudflare =
  | { state: "no-token"; reason: string }
  | { state: "not-cloudflare"; reason: string }
  | { state: "unresolved"; reason: string }
  | { state: "error"; reason: string }
  | {
      state: "ok";
      script: string;
      // Newest first, at most 10.
      deploys: CfDeploy[];
      // 24 hourly buckets, oldest first; null with a reason when the analytics query
      // failed while the deployments read did not.
      errors24: HourBucket[] | null;
      errors_reason: string | null;
    };

export interface SiteSnapshot extends SiteProbe {
  // '1' up, '0' down, '-' no pass, one character per half-hour slot, 7 days.
  ring: string;
  // The clock slot (minutes since the epoch / 30) of the ring's last character.
  ring_slot: number;
  // Absent on snapshots written before the Cloudflare read existed.
  cloudflare?: SiteCloudflare;
}

export interface CiObservation {
  namespace: string;
  // Null when the repo's runs could not be read this pass.
  latest: { head_sha: string; status: string; conclusion: string | null; created_at: string; url: string | null } | null;
}

export interface MirrorObservation {
  newest_dump: string | null;
  last_run: { at: string | null; conclusion: string | null; url: string | null } | null;
}

export interface SiteMapDrift {
  unmapped: string[];
  unknown: string[];
}

// One row of the Portal's site configuration (ops_sites, src/ops-sites.ts). A row with
// no origin says its namespace serves no site; platform is null exactly then.
export interface OpsSiteConfig {
  namespace: string;
  name: string;
  origin: string | null;
  health_path: string | null;
  platform: "cloudflare" | "vercel" | null;
  script: string | null;
  // Probed in-process rather than over HTTP: Capsid's own row. Not settable from the Portal.
  self_probe: boolean;
  // Counts edits. site_edit and site_remove name the revision they previewed.
  revision: number;
  updated_at: string;
}

export interface HealthSnapshot {
  status: "ok" | "degraded";
  sha: string;
  dirty: boolean;
  builtAt: string | null;
  schema_version: string | null;
  store: { d1: string; fts: string };
  bindings: { media: string; app_kv: string };
  backup: { last_ok: string | null; age_hours: number | null; warning?: string };
}

export interface OpsSnapshot {
  version: 1;
  pass_at: string;
  pass_ms: number;
  cadence_min: number;
  checks: Array<{ id: string; state: CheckState; findings: string[] }>;
  health: HealthSnapshot | null;
  mirror: MirrorObservation | null;
  ci: CiObservation[];
  site_map: SiteMapDrift | null;
  sites: SiteSnapshot[];
}

export type OpsJobStatus = "queued" | "claimed" | "blocked" | "done" | "failed" | "superseded";

export interface OpsJob {
  id: string;
  namespace: string;
  title: string;
  status: OpsJobStatus;
  priority: number;
  posted_by: string;
  claimed_by: string | null;
  created_at: string;
  // The last transition: there is no blocked_at or done_at column.
  updated_at: string;
  lease_expires: string | null;
  blocked_count: number;
  resumed_count: number;
  gate_required: boolean;
  // For a blocked job: the reason and the exact command, split out of result_summary
  // (commandFromSummary). Null otherwise.
  waits_on: string | null;
  command: string | null;
  result_ref: string | null;
  // Posted by agent:watcher, with its fingerprint from the title.
  finding: { fingerprint: string } | null;
}

export interface OpsAgent {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  jobs_done: number;
  jobs_failed: number;
  jobs_blocked: number;
  prs_opened: number;
  prs_merged: number;
  pr_merge_rate: number | null;
  ci_green_rate: number | null;
  median_duration_minutes: number | null;
  // The improve loop's kept and reverted attempts in the agent's namespaces, from its
  // record (src/agent-record.ts). Null for an agent that is not a namespace driver.
  attempts_kept: number | null;
  attempts_reverted: number | null;
}

export interface OpsPr {
  job_id: string;
  pr_url: string;
  merged: boolean | null;
  merge_verified_at: string | null;
  recorded_at: string;
}

export interface OpsAwaitingSeat {
  namespace: string;
  repo: string;
  number: number;
  failed: string;
  why: string;
  at: string;
}

export interface OpsSeatStart {
  enabled: boolean;
  max_sessions: number;
  in_flight: number;
  // Sessions started in the last 7 days, newest first. run_id and run_url are null
  // for a session whose runner never presented its token.
  recent: Array<{ job_id: string; namespace: string | null; at: string; run_id: number | null; run_url: string | null }>;
}

export interface OpsLoop {
  mode: string;
  budget: {
    month: string;
    caps: { actions_minutes_month: number; model_usd_month: number };
    spend: { ci_minutes: number; cost_usd: number };
    exceeded: boolean;
  };
}

export interface OpsLive {
  generated: string;
  // Every open job, and every job that ended in the last 24 hours.
  jobs: OpsJob[];
  agents: OpsAgent[];
  // Pull requests recorded against jobs in the last 7 days.
  prs: OpsPr[];
  awaiting_seat: OpsAwaitingSeat[];
  seat_start: OpsSeatStart;
  loop: OpsLoop;
  // Every roster namespace with its improve-loop pause reason, null when not paused.
  // One KV get per namespace; the heavy per-namespace detail is GET
  // /portal/api/namespaces, read when the Namespaces view opens.
  namespaces: Array<{ name: string; paused: string | null }>;
  // The site configuration, every row. With no row that has an origin, the Portal
  // shows no Sites view and no site items on the Overview.
  sites: OpsSiteConfig[];
}

export interface OpsFeed {
  // Null until the watcher has written its first pass.
  snapshot: OpsSnapshot | null;
  live: OpsLive;
  // When the next on-demand pass is allowed (POST /portal/api/ops/refresh), or null
  // when one is allowed now.
  refresh_allowed_at: string | null;
  // Whether CF_OPS_TOKEN is set, so the app can say why deploy and error columns are
  // empty.
  cloudflare_configured: boolean;
  // The double-submit CSRF value: the same value is in the HttpOnly cookie
  // capsid_portal_csrf, and the app sends it back as X-Capsid-CSRF on every action. A
  // cross-site page cannot read this body, so it cannot learn the value.
  csrf: string;
}

// ---------------------------------------------------------------------------
// The Portal's controls (capsid/research/design-portal-unify.md, section 2).
//
// Two requests, as ruled 2026-09-11: a preview that writes nothing and returns what
// will change plus a signed token, then a perform that carries only the token. Both
// are JSON POSTs with the headers X-Capsid-CSRF (the feed's csrf value) and
// Content-Type: application/json.
//   POST /portal/api/actions/preview    body PortalActionRequest -> PortalPreview
//   POST /portal/api/actions/perform    body { token }           -> PortalPerformed
//   GET  /portal/api/namespaces                                   -> PortalNamespaces
//   GET  /portal/api/activity?namespace=&actor=                   -> PortalActivity
//   GET  /portal/api/claims?job= | ?namespace=&agent=&since=&until= -> PortalClaimsJob | PortalClaimsAggregate
//   POST /portal/api/sign-out           body {}                  -> 204, the Portal's cookies expired
// A refusal is text/plain: 400 refused or invalid, 403 CSRF or cross-site, 410 the
// token expired (preview again), 413 body too large. Signed out is the gate's 302.

export type PortalAction =
  | "pause"
  | "unpause"
  | "mode"
  | "seat_start"
  | "resume_job"
  | "release_job"
  | "fail_job"
  | "revoke_agent"
  | "site_add"
  | "site_edit"
  | "site_remove";

// params by action:
//   pause         { namespace, reason }   reason required
//   unpause       { namespace }
//   mode          { value: "api" | "subscription" | "off" }
//   seat_start    { value: "on" | "off" }
//   resume_job    { id, reason }          reason required
//   release_job   { id, reason }          reason required
//   fail_job      { id, reason }          reason required
//   revoke_agent  { name }
//   site_add      { namespace, name?, origin?, health_path?, platform?, script? }
//                 no origin: the namespace serves no site, and takes no other field
//   site_edit     { namespace, revision, name?, origin?, health_path?, platform?, script? }
//                 every field is the row as it will be; revision is the one shown
//   site_remove   { namespace, revision }
export interface PortalActionRequest {
  action: PortalAction;
  params: Record<string, string>;
}

export interface PortalPreview {
  action: PortalAction;
  // One sentence: what this does, naming the target.
  summary: string;
  // Exactly what changes, one line each, from the state read now.
  changes: string[];
  // The audit rows the perform will write, as "<action> by <actor>".
  audit: string[];
  // Signed; carries action and params. Valid until expires_at.
  token: string;
  expires_at: string;
}

export interface PortalPerformed {
  action: PortalAction;
  summary: string;
  // Set when the action happened but the click's own audit row was not written.
  warning: string | null;
  // The feed as it stands after the action.
  feed: OpsFeed;
}

export interface PortalNamespace {
  namespace: string;
  paused: string | null;
  anchor_pinned: boolean;
  anchor_problem: string | null;
  best: { sha: string; score: number; recorded_at: string } | null;
  last_run: { status: string; started: string; attempts: number; kept: number; reverts: number } | null;
  totals: { runs: number; attempts: number; kept: number; reverts: number; cost_usd: number; ci_minutes: number };
  // Null means no truth report was ever run, which is not an integrity of zero.
  latest_report: { integrity: number | null; generated: string } | null;
  jobs: { queued: number; claimed: number; blocked: number; done_today: number };
  skills: { candidate: number; live: number; retired: number; offered: number; used: number; use_rate: number | null; last_evaluation: string | null };
}

export interface PortalNamespaces {
  generated: string;
  namespaces: PortalNamespace[];
}

export interface PortalActivityRow {
  // The audit_log row id: unique, so the view keys on it.
  id: number;
  at: string;
  actor: string | null;
  action: string | null;
  namespace: string | null;
  path: string | null;
  // What the row records. A job transition writes two rows with one action, actor and
  // path: "job" for the job and "document" for its mirror document. null when the
  // row's params name neither.
  target: "job" | "document" | null;
}

export interface PortalActivity {
  generated: string;
  filter: { namespace: string | null; actor: string | null };
  // Newest first, at most `limit`.
  rows: PortalActivityRow[];
  limit: number;
}

// ---------------------------------------------------------------------------
// Claims apart from verified outcomes (migrations/0023_job_claims.sql). The `claims`
// tool and GET /portal/api/claims return these, from the same readers
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

export interface ClaimsTouchSummary {
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

export interface ClaimsAggregate {
  filter: ClaimsFilter;
  groups: ClaimsGroup[];
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
