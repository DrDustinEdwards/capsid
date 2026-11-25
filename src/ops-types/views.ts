export interface WebAnalyticsSite {
  host: string;
  auto_install: boolean | null;
  enabled: boolean | null;
}

export interface DigestState {
  on: boolean;
  problem: string | null;
  to: string | null;
  hour_utc: number;
  last: { at: string; outcome: "sent" | "failed"; note: string } | null;
}

// GET /portal/api/push -> PortalPush: the VAPID public key a browser subscribes with (null with the problem
// when unset) and the devices with alerts on. Never an endpoint.
export interface PortalPush {
  generated: string;
  public_key: string | null;
  problem: string | null;
  devices: {
    id: number;
    label: string | null;
    created_at: string;
    last_sent_at: string | null;
    last_status: number | null;
  }[];
  digest: DigestState;
  // Present after op "test": each device's push service answer (0 when unreachable).
  results?: { id: number; status: number }[];
}

// GET /portal/api/stale -> PortalStale: jobs that look stuck (src/stale-jobs.ts), over every namespace. `rule` is the
// first test met: prs-settled, steps-seen, resumed-not-completed (24h+), unchanged (3 days).
export type StaleRule = "unchanged" | "resumed-not-completed" | "prs-settled" | "steps-seen";

export interface OpsStaleJob {
  id: string;
  namespace: string;
  title: string;
  status: string;
  updated_at: string;
  rule: StaleRule;
  reason: string;
}

export interface PortalStale {
  generated: string;
  rows: OpsStaleJob[];
  truncated: boolean;
  note: string | null;
}

// GET /portal/api/library -> PortalLibrary (src/portal-library.ts), read-only. One of three answers by query
// string: the shelves (none), a search (?q=) or one document (?ns=&path=).
export type LibraryShelf = "decisions" | "rulings" | "research";

export interface LibraryEntry {
  namespace: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  updated_at: string;
}

interface LibraryHit extends LibraryEntry {
  // FTS5 snippet: matched words between U+0002 and U+0003 (LIBRARY_MARK_OPEN/CLOSE), gaps as " ... ".
  snippet: string;
}

interface LibraryDocument extends LibraryEntry {
  tags: string | null;
  created_at: string;
  body: string;
}

export type PortalLibrary =
  | {
      kind: "shelves";
      generated: string;
      shelves: Record<LibraryShelf, LibraryEntry[]>;
      truncated: boolean;
    }
  | { kind: "search"; generated: string; query: string; rows: LibraryHit[]; truncated: boolean }
  | {
      kind: "document";
      generated: string;
      doc: LibraryDocument;
      outgoing: Array<{ type: string; to_ns: string; to_path: string }>;
      incoming: Array<{ type: string; from_ns: string; from_path: string }>;
    };

// GET /portal/api/trends?weeks= -> PortalTrends (src/trends.ts, src/portal-trends.ts). Read-only; times UTC, weeks start Monday.
export interface TrendMinutesWeek {
  week: string; // ISO week, "2026-W41"
  start: string; // its Monday, YYYY-MM-DD
  minutes: number;
  sessions: number;
  decisions: number;
}

export interface TrendQueueDay {
  day: string;
  posted: number;
  ended: number;
  open: number;
}

export interface TrendMergeWeek {
  week: string;
  start: string;
  auto: number; // merged by the signed policy on its own
  approved: number; // merged by the executor on an approval
  seat: number; // merged by the seat through capsid_close_pr
  closed: number; // closed without merging, from chat or the Portal
}

export interface TrendBackupSlot {
  key: string; // a day, a week's Monday, or a month (YYYY-MM)
  filled: boolean;
}

export interface TrendCiDay {
  day: string;
  runs: number;
  failed: number;
  // Last completed run that day, carried over a day with none; "none" before the first run in the window.
  state: "green" | "red" | "none";
}

export interface TrendCiRepo {
  namespace: string;
  repo: string;
  days: TrendCiDay[];
  // More runs than one page (100): the earliest days may be missing runs.
  truncated: boolean;
}

// DORA deploy measures for one repository from deploy_outcomes: every deploy whose live gate ran.
export interface TrendDeployRepo {
  repo: string;
  deploys: number;
  per_week: number; // deploy frequency
  shipped: number; // the gate passed
  refused: number; // the gate refused: rolled back, rollback failed, or the guard declined
  rolled_back: number;
  unverified: number; // the gate could not run; neither shipped nor refused
  change_failure_rate: number | null; // refused / (shipped + refused); null with none decided
  restore_median_seconds: number | null; // median time to restore over rolled-back deploys
}

export interface PortalTrends {
  generated: string;
  weeks: number;
  minutes: { weeks: TrendMinutesWeek[]; truncated: boolean; note: string };
  queue: TrendQueueDay[];
  merges: {
    weeks: TrendMergeWeek[];
    rollbacks: Array<{
      at: string;
      repo: string;
      pr: number | null;
      outcome: "rolled_back" | "rollback_failed";
    }>;
  };
  deploys: { repos: TrendDeployRepo[] };
  backups: {
    slots: {
      daily: TrendBackupSlot[];
      weekly: TrendBackupSlot[];
      monthly: TrendBackupSlot[];
    } | null;
    runs: number | null;
    error: string | null;
  };
  ci: {
    read_at: string;
    repos: TrendCiRepo[];
    not_read: Array<{ namespace: string; error: string }>;
  };
}

// GET /portal/api/maintenance -> PortalMaintenance: the last daily pass's findings and actions. A "-not-checked"
// rule is a failed read, shown so a missing read is never taken for clean.
export type MaintenanceRule =
  | "later-passed"
  | "shipped-elsewhere"
  | "followups-missing"
  | "auto-resumed"
  | "pr-awaiting-seat"
  | "pr-red"
  | "prs-not-checked"
  | "branch-merged"
  | "branch-pruned"
  | "branch-stale"
  | "branches-not-checked"
  | "undeployed-merge"
  | "deploys-not-checked"
  | "model-drift"
  | "model-not-checked"
  | "rule-doc"
  | "rule-docs-not-checked"
  | "release-tagged"
  | "release-untagged"
  | "release-backwards"
  | "releases-not-checked";

export interface OpsMaintenanceItem {
  rule: MaintenanceRule;
  namespace: string;
  job: string | null;
  pr?: string;
  line: string;
}

export interface PortalMaintenance {
  generated: string | null;
  items: OpsMaintenanceItem[];
  /** What the pass read, so an empty list differs from one that read nothing. */
  read: { prs: number; branches: number; repos: number; roster: number; deploys: number };
}

// GET /portal/api/convergence -> PortalConvergence (src/site-convergence.ts): per opted-in site, its sync_status,
// health checks with their repairs, Worker secret names (never values) and recent repairs. Read live.
export interface SecretPresence {
  name: string;
  set: boolean;
  expected: boolean;
}

export interface ConvergenceCheck {
  name: string;
  ok: boolean;
  detail: string | null;
  expected: number | null;
  present: number | null;
  // The repair the configuration maps this check to, and why Capsid may not run it (null: it may).
  repair: string | null;
  repair_refusal: string | null;
}

export interface ConvergenceSite {
  namespace: string;
  name: string;
  origin: string;
  read_at: string;
  operator: {
    path: string;
    auth_var: string;
    secret_set: boolean;
    repairs: Record<string, string>;
    weekly: string[];
  } | null;
  problem: string | null;
  status: {
    ok: boolean;
    fields: Array<{ key: string; value: string }>;
    error: string | null;
  } | null;
  health: {
    ok: boolean;
    http_status: number | null;
    checks: ConvergenceCheck[];
    error: string | null;
  } | null;
  secrets: {
    state: "ok" | "none" | "error";
    script: string | null;
    rows: SecretPresence[];
    reason: string | null;
    read_at?: string;
  } | null;
  recent: Array<{
    at: string;
    actor: string;
    tool: string;
    via: string | null;
    converged: boolean | null;
    error: string | null;
  }>;
}

export interface PortalConvergence {
  generated: string;
  sites: ConvergenceSite[];
}

// GET /portal/api/backups and capsid_admin_read_ops action backups -> PortalBackups (src/site-backup.ts): each
// site's backup_status as it answered, d1-dump's backupHealth for the newest dump and one per files pass.
interface BackupFreshness {
  last_ok: string | null;
  age_hours: number | null;
  warning?: string;
}
export interface SiteBackupStatus extends BackupFreshness {
  files?: Record<string, BackupFreshness>;
}
interface AmazonCopy {
  newest: string | null;
  bytes: number | null;
}
export interface SiteBackupRow {
  namespace: string;
  origin: string;
  status: SiteBackupStatus | null;
  error: string | null;
  amazon: AmazonCopy | null;
}
export interface PortalBackups {
  read_at: string;
  capsid: { status: BackupFreshness; amazon: AmazonCopy | null };
  sites: SiteBackupRow[];
  amazon_report_at: string | null;
  not_configured: string[];
}

// The overnight plan and morning digest (src/overnight-plan.ts): `capsid_work_jobs` list views "plan" and "digest"
// and GET /portal/api/plan and /digest serve the same readers.

interface PlannedJob {
  id: string;
  namespace: string;
  title: string;
  priority: number;
  estimate_minutes: number;
  estimate_source: "policy" | "record" | "default";
  /** Needs a human confirmation for a risky step: the session does the ordinary work and lists that step in the PR. */
  gated: boolean;
}

export interface PlanLane {
  repo: string;
  namespaces: string[];
  heavy: boolean;
  jobs: PlannedJob[];
  planned_minutes: number;
}

export interface SkippedJob {
  id: string;
  namespace: string;
  title: string;
  reason: string;
}

export interface OvernightPlan {
  generated: string;
  budget_minutes: number;
  // So "every repo is heavy" is never a surprise.
  policy: "document" | "default" | "invalid";
  policy_note: string | null;
  heavy_planned_minutes: number;
  lanes: PlanLane[];
  skipped: SkippedJob[];
  queued_read: number;
  truncated: boolean;
}

export interface UsageTotals {
  cost_usd: number | null;
  active_seconds: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
}

export interface DigestJob {
  id: string;
  namespace: string;
  title: string;
  status: string;
  result_kind: string | null;
  duration_minutes: number | null;
  blocked_count: number | null;
  usage: UsageTotals;
}

export interface DigestBlocked {
  id: string;
  namespace: string;
  title: string;
  at: string;
  summary: string;
  pull_requests: string[];
  usage: UsageTotals;
}

export interface DigestPr {
  job_id: string;
  namespace: string;
  url: string;
  state: "merged" | "open" | "unchecked";
  source: "outcome" | "blocked summary";
}

export interface OvernightDigest {
  generated: string;
  since: string;
  for_namespace: string | null;
  finished: DigestJob[];
  blocked: DigestBlocked[];
  pull_requests_ready: DigestPr[];
  pull_requests_merged: number;
  totals: {
    usage: UsageTotals & { jobs: number };
    jobs_without_usage: number;
  };
  truncated: string[];
}

export type PortalPlan = OvernightPlan;

// GET /portal/api/digest?since= -> PortalDigest over every namespace; since defaults to 24 hours, a non-ISO one is a 400.
export type PortalDigest = OvernightDigest;

// Merge units suspended after a rollback of an unattended merge, plus the units tick's promote and demote proposals.
export interface PortalMergeUnits {
  generated: string | null;
  suspended: Array<{ unit: string; since: string; reason: string }>;
  proposals: Array<{ kind: "promote" | "demote"; unit: string; title: string }>;
}
