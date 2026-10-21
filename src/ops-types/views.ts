/** One Web Analytics site as the live checks read it. The site token is never kept. */
export interface WebAnalyticsSite {
  host: string;
  // Whether the snippet is injected automatically for the host's orange-clouded traffic.
  auto_install: boolean | null;
  // The site's ruleset switch, where Cloudflare reports one.
  enabled: boolean | null;
}

// The daily email digest (src/digest.ts), as Settings shows it: on, or the reason it is
// off, where it goes, the hour it is sent, and the last send or refusal.
export interface DigestState {
  on: boolean;
  problem: string | null;
  to: string | null;
  hour_utc: number;
  last: { at: string; outcome: "sent" | "failed"; note: string } | null;
}

// GET /portal/api/push -> PortalPush. Phone alerts (src/push.ts): the VAPID public key a
// browser subscribes with (null, with the problem, when the key is not set), and the
// devices with alerts on. Never an endpoint.
export interface PortalPush {
  generated: string;
  public_key: string | null;
  problem: string | null;
  devices: { id: number; label: string | null; created_at: string; last_sent_at: string | null; last_status: number | null }[];
  // The daily email digest beside the alerts, so Settings says why it is off.
  digest: DigestState;
  // Present after op "test": each device's push service answer (0 when unreachable).
  results?: { id: number; status: number }[];
}

// GET /portal/api/stale -> PortalStale. The jobs that look stuck, from the reader behind
// `capsid_work_jobs` action list with stale: true (src/stale-jobs.ts), over every namespace. rule is
// which test the job met, the most actionable first: prs-settled (blocked, and every pull
// request it names is merged or closed), steps-seen (blocked, and every manual step its
// "check:" lines name is seen, src/manual-steps.ts), resumed-not-completed (the
// merge-resume step resumed it 24 hours or more ago and it is not done), unchanged
// (blocked or claimed, and its row has not changed in 3 days).
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
  // Oldest change first, at most 200.
  rows: OpsStaleJob[];
  truncated: boolean;
  // Set when rows may be missing: more than 200, or the pull request cache unreadable.
  note: string | null;
}

// GET /portal/api/library -> PortalLibrary (src/portal-library.ts). The read-only Library
// over the knowledge store. One of
// three answers, by the query string: the shelves (no query), a search (?q=) or one
// document (?ns=&path=). Writing stays in chat and with drivers.
export type LibraryShelf = "decisions" | "rulings" | "research";

export interface LibraryEntry {
  namespace: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  updated_at: string;
}

export interface LibraryHit extends LibraryEntry {
  // FTS5's snippet: each matched word between U+0002 and U+0003 (LIBRARY_MARK_OPEN and
  // LIBRARY_MARK_CLOSE in src/portal-library.ts), gaps as " ... ".
  snippet: string;
}

interface LibraryDocument extends LibraryEntry {
  tags: string | null;
  created_at: string;
  body: string;
}

export type PortalLibrary =
  | { kind: "shelves"; generated: string; shelves: Record<LibraryShelf, LibraryEntry[]>; truncated: boolean }
  | { kind: "search"; generated: string; query: string; rows: LibraryHit[]; truncated: boolean }
  | {
      kind: "document";
      generated: string;
      doc: LibraryDocument;
      outgoing: Array<{ type: string; to_ns: string; to_path: string }>;
      incoming: Array<{ type: string; from_ns: string; from_path: string }>;
    };

// GET /portal/api/trends?weeks= -> PortalTrends (src/trends.ts, src/portal-trends.ts). The
// series the Portal's charts need and the feed does not carry (design-portal-evaluation.md
// section 3, ruled 2026-10-09). Read-only; every time is UTC; weeks start on Monday.
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
  // Open (queued, claimed, blocked or parked) at the day's end.
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

export interface TrendCostWeek {
  week: string;
  start: string;
  // Model spend of the jobs that ended that week, from their outcome rows' telemetry
  // cost. Null when no outcome that week carried a cost, which is not a spend of zero.
  usd: number | null;
  // Outcome rows that carried a cost.
  jobs: number;
}

export interface TrendBackupSlot {
  key: string; // a day, a week's Monday, or a month (YYYY-MM)
  filled: boolean;
}

export interface TrendCiDay {
  day: string;
  runs: number;
  failed: number;
  // The default branch at the day's end: the last completed run that day, carried over a
  // day with none; "none" before the first run in the window.
  state: "green" | "red" | "none";
}

export interface TrendCiRepo {
  namespace: string;
  repo: string;
  days: TrendCiDay[];
  // More runs than one page (100) in the window: the earliest days may be missing runs.
  truncated: boolean;
}

export interface PortalTrends {
  generated: string;
  weeks: number;
  minutes: { weeks: TrendMinutesWeek[]; truncated: boolean; note: string };
  queue: TrendQueueDay[];
  merges: { weeks: TrendMergeWeek[]; rollbacks: Array<{ at: string; repo: string; pr: number | null; outcome: "rolled_back" | "rollback_failed" }> };
  // Visual 6: model spend per week (a read-only sum over job_outcomes.cost_usd).
  cost: { weeks: TrendCostWeek[] };
  // null slots and runs, with error set, when the bucket could not be listed.
  backups: { slots: { daily: TrendBackupSlot[]; weekly: TrendBackupSlot[]; monthly: TrendBackupSlot[] } | null; runs: number | null; error: string | null };
  // Read from GitHub and kept an hour; a repo that could not be read is in not_read.
  ci: { read_at: string; repos: TrendCiRepo[]; not_read: Array<{ namespace: string; error: string }> };
}

// GET /portal/api/maintenance -> PortalMaintenance. The daily maintenance pass's list
// (src/maintenance.ts), as stored by its last run: what the pass found that it did not act
// on, and what it acted on (an auto-resume, a pruned branch). A "-not-checked" rule is a
// read that failed, shown so a missing read is never taken for a clean result.
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
  // The release-tag rule (src/maintenance-releases.ts): a shared package's version tagged,
  // left untagged (switched off, over the cap, not found), or below its newest tag.
  | "release-tagged"
  | "release-untagged"
  | "release-backwards"
  | "releases-not-checked";

export interface OpsMaintenanceItem {
  /** Which rule found it. */
  rule: MaintenanceRule;
  namespace: string;
  /** The job the line is about, or null for a line that names none. */
  job: string | null;
  /** The pull request the line is about, for the pull request rules. */
  pr?: string;
  /** One plain line for the seat: what is wrong and what to do. */
  line: string;
}

export interface PortalMaintenance {
  /** When the pass that wrote the list ran; null when no pass has run yet. */
  generated: string | null;
  items: OpsMaintenanceItem[];
  /** What the pass read, so an empty list can be told from one that read nothing: open
   *  pull requests, branches and compared site deploys summed over the repos read, the
   *  repos read of the roster. */
  read: { prs: number; branches: number; repos: number; roster: number; deploys: number };
}

// GET /portal/api/convergence -> PortalConvergence (src/site-convergence.ts). Per site
// that opted into Capsid calling its operator API: what that API's sync_status says, what
// its health route says per check with the repair each maps to, the site Worker's secrets
// by name (never a value), and the last repairs Capsid ran. Read live on each request.
export interface SecretPresence {
  name: string;
  set: boolean;
  // false: the Worker has it, and the site's configuration does not name it.
  expected: boolean;
}

export interface ConvergenceCheck {
  name: string;
  ok: boolean;
  detail: string | null;
  expected: number | null;
  present: number | null;
  // The repair the site's configuration maps this check to, and why Capsid may not run
  // it, where it may not (null: it may).
  repair: string | null;
  repair_refusal: string | null;
}

export interface ConvergenceSite {
  namespace: string;
  name: string;
  origin: string;
  read_at: string;
  // Null with `problem` set when the site has no usable operator configuration.
  operator: { path: string; auth_var: string; secret_set: boolean; repairs: Record<string, string>; weekly: string[] } | null;
  problem: string | null;
  // sync_status, as label and text; error says why it was not read.
  status: { ok: boolean; fields: Array<{ key: string; value: string }>; error: string | null } | null;
  health: { ok: boolean; http_status: number | null; checks: ConvergenceCheck[]; error: string | null } | null;
  // The watcher's last read of the names (read_at), or why there is none.
  secrets: { state: "ok" | "none" | "error"; script: string | null; rows: SecretPresence[]; reason: string | null; read_at?: string } | null;
  // Newest first.
  recent: Array<{ at: string; actor: string; tool: string; via: string | null; converged: boolean | null; error: string | null }>;
}

export interface PortalConvergence {
  generated: string;
  sites: ConvergenceSite[];
}

// THE OVERNIGHT PLAN AND THE MORNING DIGEST (src/overnight-plan.ts): the `capsid_work_jobs` action list views
// "plan" and "digest", and the Portal's GET /portal/api/plan and GET /portal/api/digest,
// which serve the same readers.

interface PlannedJob {
  id: string;
  namespace: string;
  title: string;
  priority: number;
  estimate_minutes: number;
  estimate_source: "policy" | "record" | "default";
  /** The job needs a human confirmation for a risky step (gate_required): the session
   *  does the ordinary work and lists that step in the pull request for the seat. */
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
  // Where the heavy/light split came from, so "every repo is heavy" is never a surprise.
  policy: "document" | "default" | "invalid";
  policy_note: string | null;
  // Heavy lanes share this budget; their sessions run one at a time.
  heavy_planned_minutes: number;
  lanes: PlanLane[];
  skipped: SkippedJob[];
  // Counts beside the verdict, so an empty plan cannot pass for a clean one.
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
  usage_source: UsageSource;
}

export interface DigestBlocked {
  id: string;
  namespace: string;
  title: string;
  at: string;
  // The reason and the command, as the driver wrote them, cut to a readable length.
  summary: string;
  pull_requests: string[];
  usage: UsageTotals;
  usage_source: UsageSource;
}

export interface DigestPr {
  job_id: string;
  namespace: string;
  url: string;
  // merged: GitHub says merged. open: not merged (open or closed). unchecked: never read.
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
  // Per source, never one added to the other: a job in both would count twice.
  totals: { telemetry: UsageTotals & { jobs: number }; reported: UsageTotals & { jobs: number }; jobs_without_usage: number };
  truncated: string[];
}

export type UsageSource = "telemetry" | "reported" | "none";

// GET /portal/api/plan -> PortalPlan: the overnight plan over every namespace.
export type PortalPlan = OvernightPlan;

// GET /portal/api/digest?since= -> PortalDigest: what happened since then, over every
// namespace. since defaults to the last 24 hours; one that is not an ISO time is a 400.
export type PortalDigest = OvernightDigest;
