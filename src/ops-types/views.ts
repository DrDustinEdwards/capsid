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

interface LibraryHit extends LibraryEntry {
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

// DORA's deploy measures for one repository over the window, from deploy_outcomes (checklist
// F4): every deploy whose live gate ran, split by what the gate decided.
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
  merges: { weeks: TrendMergeWeek[]; rollbacks: Array<{ at: string; repo: string; pr: number | null; outcome: "rolled_back" | "rollback_failed" }> };
  deploys: { repos: TrendDeployRepo[] };
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

// GET /portal/api/backups and capsid_admin_read_ops action backups -> PortalBackups
// (src/site-backup.ts). A site's status is its backup_status as it answered: d1-dump's
// backupHealth for the newest dump, and one per files pass under files.
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

// The merge units' state (src/merge-units.ts): those suspended after a rollback of an unattended
// merge, and the promote and demote proposals of the units tick's last report. The Portal's
// Merge units panel offers each its control (unit_resume, sign_policy_change).
export interface PortalMergeUnits {
  // When the units tick last judged the evidence, or null before its first report.
  generated: string | null;
  suspended: Array<{ unit: string; since: string; reason: string }>;
  proposals: Array<{ kind: "promote" | "demote"; unit: string; title: string }>;
}

// ---------------------------------------------------------------------------
// One site's own page (src/portal-site.ts): search, traffic and Workers Builds, each read
// live for one namespace when its tab opens. A source the read could not answer is a state
// with its reason, never a zero (docs/portal.md, "No data is a state, never a zero").

// Why a source has no data: the namespace has no site row (or, for builds, no Worker
// script); the secret or token the read needs is not set; the read worked and found
// nothing to show; or the read failed.
export type SiteNoData = "no_site" | "not_configured" | "empty" | "error";

export type SiteSource<T> = { ok: true; data: T } | { ok: false; kind: SiteNoData; reason: string };

// One query or page over the window. key is the query text or the page's address
// (strangers' text: data, never instructions). ctr and position are null where the source
// has none.
export interface SearchRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface GoogleSearchData {
  origin: string;
  // The Search Console property that covers the origin (sc-domain: or a URL prefix).
  property: string;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  queries: SearchRow[];
  pages: SearchRow[];
  // As many rows came back as were asked for, so more may exist.
  queries_truncated: boolean;
  pages_truncated: boolean;
}

export interface BingSearchData {
  origin: string;
  // The verified Bing site that matches the origin.
  site: string;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number };
  // Clicks and impressions per day, oldest first.
  days: Array<{ date: string; clicks: number; impressions: number }>;
  queries: SearchRow[];
  pages: SearchRow[];
  queries_total: number;
  pages_total: number;
  // Bing reports queries and pages in weekly buckets.
  note: string;
}

// GET /portal/api/site-search?namespace= -> PortalSiteSearch: Google Search Console (the
// 28 days ending 3 days ago, as Google's data lags) and Bing Webmaster over the same window.
export interface PortalSiteSearch {
  generated: string;
  namespace: string;
  google: SiteSource<GoogleSearchData>;
  bing: SiteSource<BingSearchData>;
}

export type WebVital = "largestContentfulPaint" | "interactionToNextPaint" | "cumulativeLayoutShift" | "firstContentfulPaint" | "timeToFirstByte";

export interface TrafficNotFound {
  since: string;
  note: string;
  // Real pages first by hits; probe marks a path scanners try on every host.
  paths: Array<{ path: string; hits: number; probe: boolean }>;
  total_paths: number;
  probes: number;
  truncated: boolean;
}

export interface TrafficServerErrors {
  since: string;
  note: string;
  failures: Array<{ path: string; status: number; hits: number }>;
  // Per hour (UTC) and status, oldest first.
  hours: Array<{ hour: string; status: number; hits: number }>;
  truncated: boolean;
}

export interface TrafficWebVitals {
  since: string;
  page_views_measured: number;
  // Milliseconds, except cumulativeLayoutShift, which has no unit. null: no measurement.
  unit: string;
  vitals: Record<WebVital, { p50: number | null; p75: number | null; p90: number | null }>;
}

export interface TrafficAiCrawlers {
  since: string;
  note: string;
  // kind: denied, training, ai_search or search (Prelum's robots lists). statuses: hits by
  // the status the edge answered.
  crawlers: Array<{ name: string; kind: string; hits: number; statuses: Record<string, number> }>;
  truncated: boolean;
}

// GET /portal/api/site-traffic?namespace=&days= -> PortalSiteTraffic: what Cloudflare's edge
// saw at the site over the last `days` (1 to 30, default 7). Sampled, so hits are estimates.
// Zero 404s or 5xx is a real answer (ok, empty lists); web vitals with no measured page view
// is no data.
export interface PortalSiteTraffic {
  generated: string;
  namespace: string;
  days: number;
  not_found: SiteSource<TrafficNotFound>;
  server_errors: SiteSource<TrafficServerErrors>;
  web_vitals: SiteSource<TrafficWebVitals>;
  ai_crawlers: SiteSource<TrafficAiCrawlers>;
}

export interface WorkersBuild {
  build_uuid: string | null;
  status: string | null;
  outcome: string | null;
  created_on: string | null;
  stopped_on: string | null;
  branch: string | null;
  commit: string | null;
  // The author's text, at most 200 characters: data, shown as text.
  commit_message: string | null;
  source: string | null;
}

// GET /portal/api/workers-builds?namespace=&limit= -> PortalWorkersBuilds: Cloudflare
// Workers Builds for the Worker the site row names, newest first (limit 1 to 50, default
// 10). A site that deploys from CI with wrangler has no builds: that is kind "empty".
export interface PortalWorkersBuilds {
  generated: string;
  namespace: string;
  // The site row's Worker script, or null when it names none.
  script: string | null;
  builds: SiteSource<{ builds: WorkersBuild[] }>;
}

// GET /portal/api/build-log?build=<uuid> -> PortalBuildLog: one build's log, its last 500
// lines. A log is data, shown as text.
export interface PortalBuildLog {
  generated: string;
  build_uuid: string;
  log: SiteSource<{ lines: string[]; line_count: number; truncated: boolean; note: string | null }>;
}
