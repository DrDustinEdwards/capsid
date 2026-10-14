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
  // The site's operator API, where it opted in (migrations/0035, src/site-operator.ts);
  // null where it has none. operator_problem says why a stored value was not usable.
  operator: SiteOperator | null;
  operator_problem: string | null;
}

// A site's operator API as Capsid may use it: where it is, which Capsid Worker secret
// holds its token (the name only), which repair each failing health check maps to (in
// repair order), the tools run once a week, and the names of the site Worker's secrets
// to report set or not.
export interface SiteOperator {
  path: string;
  // The name of the Capsid Worker secret holding the site's operator token.
  auth_var: string;
  repairs: Record<string, string>;
  weekly: string[];
  secrets: string[];
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
  // Each configured package as this pass read it (src/ops-packages.ts). Optional, so a
  // snapshot written before the panel existed still parses; absent or empty with no
  // package configured.
  packages?: PackageSnapshot[];
}

// One row of the Portal's package configuration (ops_packages, migrations/0028).
export interface OpsPackageConfig {
  // The npm name, the row's key.
  name: string;
  registry: "npm";
  // owner/name on GitHub, or null.
  repo: string | null;
  // An earlier npm name whose download history is shown joined to this one, or null.
  formerly: string | null;
  // Counts edits. package_edit and package_remove name the revision they previewed.
  revision: number;
  updated_at: string;
}

// One part of a package's read: what it said, or why it could not be read. "none" is
// an answer (no repository configured, no dependents on record), not a failure.
export type PackagePart<T> = ({ state: "ok" } & T) | { state: "none"; reason: string } | { state: "error"; reason: string };

// What one watcher pass read for one package. Every source is named where it is used
// (src/ops-packages.ts), with what it counts and what it misses.
export interface PackageSnapshot {
  name: string;
  registry: "npm";
  at: string;
  // registry.npmjs.org, the abbreviated document.
  npm: PackagePart<{ latest: string | null; dist_tags: Record<string, string>; versions: number; modified: string | null }>;
  // api.npmjs.org: the last 7 and 30 days, and per version for the last 7 days only
  // (npm keeps no per-version history). through is the last day npm has counted.
  downloads: PackagePart<{ last_week: number; last_month: number; through: string | null; by_version_last_week: Record<string, number> }>;
  // deps.dev v3alpha, for the default version: distinct packages that depend on it,
  // directly or through another package. Counts only; no public API lists them.
  dependents: PackagePart<{ version: string; direct: number; indirect: number; total: number }>;
  // The GitHub App's read of the repository.
  github: PackagePart<{ repo: string; stars: number; open_issues: number; open_prs: number; open_prs_capped: boolean; latest_release: { tag: string; published_at: string | null } | null }>;
}

// GET /portal/api/packages/history?name=: the daily download history of one configured
// package, joined to its former name's, and its weekly GitHub numbers.
export interface PortalPackageHistory {
  name: string;
  formerly: string | null;
  generated: string;
  // Served from the cache when it is younger than its TTL; the time it was fetched.
  fetched_at: string;
  // One entry per day with any count, oldest first; each day names which package the
  // count came from.
  days: Array<{ day: string; downloads: number; name: string }>;
  first_day: string | null;
  last_day: string | null;
  // Why a range could not be read, and anything else a reader should know.
  notes: string[];
  weeks: Array<{ week: string; stars: number; open_issues: number; open_prs: number; latest_release: string | null }>;
}

export type OpsJobStatus = "queued" | "claimed" | "blocked" | "done" | "failed" | "superseded" | "parked";

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
  blocked_count: number;
  resumed_count: number;
  gate_required: boolean;
  // For a blocked job: the reason and the exact command, split out of result_summary
  // (commandFromSummary). Null otherwise.
  waits_on: string | null;
  command: string | null;
  // Whether that command is the one the holder's block wrote (src/job-signing.ts):
  // "mismatch" withholds it (command is null), "legacy-unsigned" is a block from before
  // signing. Null for a job that is not blocked.
  command_signature: "verified" | "legacy-unsigned" | "mismatch" | "unconfigured" | null;
  // A blocked job that asks something (capsid_work_jobs action block with question: true), answered by a
  // resume note, rather than one waiting on a command to be run. Optional so a feed written
  // before it, and the app's sample data, stay valid.
  question?: boolean;
  // A parked job (src/jobs-park.ts): the one line saying when it comes back. Absent for
  // every other status, and in a feed written before parked jobs were shown.
  parked_reason?: string;
  // The started label (src/jobs-begin.ts): who began a job worked without a claim, and
  // when. Absent for a job nobody began, and in a feed written before the label existed.
  started_by?: string;
  started_at?: string;
  result_ref: string | null;
  // Posted by agent:watcher, with its fingerprint from the title, and how often the
  // watcher has seen it (seen_count, last_seen) while this is the finding's current
  // job; both null otherwise (src/watcher-findings.ts).
  finding: { fingerprint: string; seen_count: number | null; last_seen: string | null } | null;
}

export interface OpsAgent {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  // When the watcher pass moved it to the archive (src/agents-archive.ts); null while
  // its row is in agents. The Agents roster lists rows with neither date set.
  archived_at: string | null;
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
  // The merge pipeline's class, report-only (src/merge-class.ts); absent on older sets.
  class?: "auto" | "approve" | "typed" | "seat" | "wait" | null;
  path_class?: string | null;
  class_reasons?: string[];
  // The head the tick judged; the Portal's Approve sends it as the sha approved.
  head_sha?: string;
  // A pull request labelled visual (src/visual-pr.ts): its title, the live preview its
  // description names, and its screenshots, all read from the pull request itself.
  visual?: { title: string; preview: string | null; shots: string[] };
}

// The overnight run's switch (src/overnight.ts). decision is present only while the mode is
// subscription: who decided, when, the ruling and its reasoning, and who set the switch.
export interface OpsOvernight {
  mode: "off" | "api" | "subscription";
  decision: {
    decided_by: string;
    decided_on: string;
    ruling: string;
    reasoning: string;
    set_by: string;
    set_at: string;
    reason: string;
  } | null;
}

// A Claude Code session Capsid has heard from through its hooks (POST /ops/hooks,
// src/ops-hooks.ts). Summaries only: no prompt, response or tool content is kept.
export interface OpsSession {
  session_id: string;
  // The key that reported it, as an actor string (agent:<name>).
  agent: string;
  // The job it was first bound to, and that job's namespace; null when the key held no
  // single job at its first event.
  job_id: string | null;
  namespace: string | null;
  // SessionStart's source (startup, resume, clear, compact, fork) and model.
  source: string | null;
  model: string | null;
  permission_mode: string | null;
  started_at: string;
  last_event_at: string;
  // The newest hook event's name, and the newest Notification's type.
  last_event: string;
  last_notification_type: string | null;
  // Waiting on a person: a permission prompt, an idle prompt, an elicitation dialog.
  needs_input: boolean;
  // The newest StopFailure's error (rate_limit, billing_error, ...), until a turn ends
  // normally.
  last_failure: string | null;
  // Why the session is an incident now, decided when the feed is read (no job is
  // posted): "failure" for a StopFailure a person must act on (rate_limit,
  // billing_error, authentication_failed, account_on_hold, oauth_org_not_allowed),
  // "waiting" for needing input more than ten minutes. Null otherwise.
  incident: "failure" | "waiting" | null;
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

// Shared code (src/shared-code.ts): GET /portal/api/shared-code.
export interface SharedCodeApp {
  namespace: string;
  name: string;
  // The manifest it was read from ("package.json", "dashboard/package.json") or "renovate".
  where: string;
  // The tag the app pins, or the lockfile's version for a spec with no tag; null when
  // neither says (a branch).
  pinned: string | null;
  // Release tags newer than the pin, or null when the pin is not a release.
  behind: number | null;
  // Pinned through a repo's earlier name (GitHub redirects it).
  via_old_name: boolean;
}

export interface SharedCodePackage {
  name: string;
  repo: string;
  latest: string | null;
  tags_error: string | null;
  users: SharedCodeApp[];
  // Users at least one release behind.
  behind: number;
  // Known local copies the package replaces; present is null when that app's tree could not be read.
  local_copies: Array<{ namespace: string; path: string; present: boolean | null }>;
  local_left: number;
}

export interface SharedCodeView {
  generated: string;
  configured: boolean;
  error: string | null;
  // How many apps were read, so "nobody is behind" is never "nothing was read".
  apps_read: number;
  apps_failed: Array<{ namespace: string; error: string }>;
  packages: SharedCodePackage[];
}

// What needs Dustin, per app (src/inbox.ts): GET /ops/inbox, capsid_run_improve action
// status's needs_dustin, and the Portal's Needs you page all carry this one shape.
export type InboxSeverity = "needs-you" | "failing" | "none";
// "proposal": a merge unit promotion, demotion or suspension (src/merge-units.ts).
export type InboxKind = "blocked-job" | "question" | "pr" | "ci" | "site-down" | "report" | "proposal";

export interface InboxItem {
  title: string;
  kind: InboxKind;
  /** Where to act on it, or null when there is no page for it. */
  link: string | null;
  /** When it started waiting, ISO. The shell shows the age. */
  since: string;
  /** The job it is, for a blocked job or a question, so the Portal opens the job's panel
   *  when there is no link. Absent on every other kind. */
  job?: string;
}

export interface InboxApp {
  namespace: string;
  name: string;
  count: number;
  severity: InboxSeverity;
  items: InboxItem[];
}

export interface Inbox {
  generated: string;
  /** Items across the apps this caller may read. */
  count: number;
  severity: InboxSeverity;
  apps: InboxApp[];
}

// One namespace's last seven days of auto-merge, the safety meter (src/merge-safety.ts).
// approved: merges Dustin approved. bad_auto_7d: rollbacks and reverts of pull requests
// the tick merged unattended. paused: the shutoff, with when and why, or null.
export interface OpsMergeSafetyRow {
  namespace: string;
  auto_merged: number;
  approved: number;
  deploys_verified: number;
  rolled_back: number;
  rollback_failed: number;
  reverts: number;
  bad_auto_7d: number;
  paused: { since: string; reason: string } | null;
}

export interface OpsMergeSafety {
  generated: string;
  namespaces: OpsMergeSafetyRow[];
}

export interface OpsLive {
  generated: string;
  // Every open job, and every job that ended in the last 24 hours.
  jobs: OpsJob[];
  agents: OpsAgent[];
  // Pull requests recorded against jobs in the last 7 days.
  prs: OpsPr[];
  awaiting_seat: OpsAwaitingSeat[];
  // The auto-merge safety meter the tick's merge-safety step kept, or null before its
  // first pass. One KV get, no D1 or GitHub read.
  merge_safety: OpsMergeSafety | null;
  overnight: OpsOvernight;
  // Sessions with no SessionEnd whose last event was in the last 24 hours, newest
  // first, at most 50.
  sessions: OpsSession[];
  loop: OpsLoop;
  // Every roster namespace with its improve-loop pause reason, null when not paused.
  // One KV get per namespace; the heavy per-namespace detail is GET
  // /portal/api/namespaces, read when the Namespaces view opens.
  namespaces: Array<{ name: string; paused: string | null }>;
  // The site configuration, every row. With no row that has an origin, the Portal
  // shows no Sites view and no site items on the Overview.
  sites: OpsSiteConfig[];
  // The package configuration, every row. With none, the Portal shows no Packages view.
  packages: OpsPackageConfig[];
  // The D1 store's size, from the jobs read's meta.size_after (null when D1 did not
  // report it), against the per-database cap (D1_CAP_BYTES in src/ops-feed.ts).
  store: { size_bytes: number | null; cap_bytes: number };
  // Drivers' writes to canon documents waiting for approval (src/canon.ts), oldest
  // first, at most 50.
  canon_proposals: OpsCanonProposal[];
  // What needs Dustin, per app, from the same gatherer GET /ops/inbox answers with
  // (src/inbox.ts), unrestricted: the Portal is the admin's.
  inbox: Inbox;
  // The watcher's open findings that post no job (src/watcher.ts, findingClass): class
  // digest feeds the weekly digest per site, class attention the attention list.
  findings: OpsFinding[];
}

export interface OpsFinding {
  fingerprint: string;
  namespace: string;
  class: "digest" | "attention";
  headline: string;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  // The newest sighting's evidence lines, at most three.
  evidence: string[];
}

// One pending canon proposal, measured against the document as it is now. stale: the
// document moved past the body the proposal was written against, so it can only be
// rejected. directive_lines: the added lines that read as instructions to agents.
export interface OpsCanonProposal {
  id: number;
  namespace: string;
  path: string;
  proposer: string;
  created_at: string;
  creates: boolean;
  stale: boolean;
  added: number;
  removed: number;
  directive_lines: string[];
}

// The run ledger (src/task-runs.ts): each scheduled task's newest runs, and its flag
// decided when the feed was read. failing: the newest run threw or was refused.
// quiet: a periodic task with no run in twice its period. never: no run recorded.
export type OpsTaskRunOutcome = "ok" | "skipped" | "refused" | "threw";

export interface OpsTaskRun {
  started_at: string;
  finished_at: string;
  outcome: OpsTaskRunOutcome;
  // One line: what the run did, or why it did not.
  reason: string;
}

export interface OpsTask {
  id: string;
  label: string;
  // Null for a task whose runs follow the work, which is flagged only when it fails.
  period_ms: number | null;
  flag: "failing" | "quiet" | "never" | null;
  // Newest first, at most five.
  recent: OpsTaskRun[];
}

export interface OpsFeed {
  // Null until the watcher has written its first pass.
  snapshot: OpsSnapshot | null;
  live: OpsLive;
  // The run ledger, or why it could not be read.
  scheduled: { tasks: OpsTask[]; error: null } | { tasks: null; error: string };
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
  // Who is signed in, for the top bar: from the session, never from configuration.
  user: { name: string; initials: string };
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
//   GET  /portal/api/activity?namespace=&actor= | ?id=           -> PortalActivity
//   GET  /portal/api/claims?job= | ?namespace=&agent=&since=&until= -> PortalClaimsJob | PortalClaimsAggregate
//   GET  /portal/api/packages/history?name=                       -> PortalPackageHistory
//   GET  /portal/api/stale                                        -> PortalStale
//   GET  /portal/api/plan                                         -> PortalPlan
//   GET  /portal/api/digest?since=                                -> PortalDigest
//   GET  /portal/api/maintenance                                  -> PortalMaintenance
//   GET  /portal/api/convergence                                  -> PortalConvergence
//   GET  /portal/api/push                                         -> PortalPush
//   POST /portal/api/push   body { op: "on", subscription, label } | { op: "off", id } | { op: "test" } -> PortalPush
//   POST /portal/api/sign-out           body {}                  -> 204, the Portal's cookies expired
// A refusal is text/plain: 400 refused or invalid, 403 CSRF or cross-site, 410 the
// token expired (preview again), 413 body too large. Signed out is the gate's 302.

export type PortalAction =
  | "pause"
  | "unpause"
  | "mode"
  | "overnight"
  | "resume_job"
  | "release_job"
  | "fail_job"
  | "close_shipped"
  | "supersede_job"
  | "park_job"
  | "unpark_job"
  | "pr_close"
  | "approve_pr"
  | "revoke_agent"
  | "site_add"
  | "site_edit"
  | "site_remove"
  | "reset_breaker"
  | "package_add"
  | "package_edit"
  | "package_remove"
  | "canon_approve"
  | "canon_reject"
  | "site_repair"
  // The merge units (docs/design/design-merge-pipeline.md section 7): a signed policy
  // change that promotes or removes a unit, and the Undo of a unit's suspension.
  | "sign_policy_change"
  | "unit_resume"
  // Lift a namespace's auto-merge pause (src/merge-safety.ts), the shutoff after bad
  // unattended merges.
  | "automerge_resume";

// params by action:
//   pause         { namespace, reason, undo? }   reason required
//   unpause       { namespace, reason, undo? }   reason required
//   mode          { value: "api" | "subscription" | "off", reason, undo? }   reason required
//   overnight     { value: "off" | "api" | "subscription", reason, undo? }   reason required
//                 choosing subscription records Dustin's decision, its date and its
//                 reasoning with the switch (src/overnight.ts)
//                 undo: "true" marks the reverse of a change just made, from the
//                 Portal's Undo; the click row is then portal-undo-<action>
//                 instead of portal-<action>.
//   resume_job    { id, reason, note? }   reason required; note is the full approval,
//                 which the driver reads as resume_note.note
//   release_job   { id, reason }          reason required
//   fail_job      { id, reason }          reason required
//   close_shipped { id, reason }          reason required; the seat's complete of a
//                 blocked job another credential holds, credited to that holder
//   supersede_job { id, reason, replaced_by? }   reason required; a queued job, or a
//                 claimed one with no work recorded, ends as superseded (no outcome)
//   park_job      { id, reason, undo? }   reason required, one line: when it comes back
//   unpark_job    { id, reason?, undo? }  a parked job goes back to the queue; the reason
//                 is recorded in the click row only (unpark itself takes none)
//   pr_close      { namespace, number, reason, repo? }   reason required; closes an open
//                 pull request as capsid_close_pr action close does, head branch cleanup included
//   approve_pr    { namespace, prs, shas, repo?, confirm?, reason?, undo? }   prs and shas
//                 comma-separated, in the same order: each pull request at the head sha
//                 that was reviewed. Records approvals (src/pr-approvals.ts) and never
//                 merges; a typed (money) one only alone, with its number as confirm.
//                 undo: "true" voids the open approvals of prs, "undone"
//   revoke_agent  { name }
//   site_add      { namespace, name?, origin?, health_path?, platform?, script? }
//                 no origin: the namespace serves no site, and takes no other field
//   site_edit     { namespace, revision, name?, origin?, health_path?, platform?, script? }
//                 every field is the row as it will be; revision is the one shown
//   site_remove   { namespace, revision }
//   reset_breaker { namespace }           the queue's circuit breaker (src/job-breaker.ts)
//   package_add   { name, repo?, formerly? }
//   package_edit  { name, revision, repo?, formerly? }   the row as it will be
//   package_remove { name, revision }
//   canon_approve { id }                  a pending canon proposal (src/canon.ts); refused
//                 when the document moved past the body it was written against
//   canon_reject  { id, reason }          reason required; the proposer reads it
//   site_repair   { namespace, tool }     one allowlisted tool on a site's operator API
//                 (src/site-repair.ts); refused for a tool outside the site's list or the
//                 Worker's ceiling, and while the rate limit holds
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
  // The queue's circuit breaker: open after the threshold of holder fails in 24 hours,
  // until reset. since is the window's start in audit_log's UTC format.
  breaker: { open: boolean; failed: number; threshold: number; since: string; reset_at: string | null };
  anchor_pinned: boolean;
  anchor_problem: string | null;
  best: { sha: string; score: number; recorded_at: string } | null;
  last_run: { status: string; started: string; attempts: number; kept: number; reverts: number } | null;
  totals: { runs: number; attempts: number; kept: number; reverts: number; cost_usd: number; ci_minutes: number };
  // Null means no truth report was ever run, which is not an integrity of zero.
  latest_report: { integrity: number | null; generated: string } | null;
  jobs: { queued: number; claimed: number; blocked: number; done_today: number };
  skills: { candidate: number; live: number; retired: number; last_evaluation: string | null };
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
  // What the row recorded, by name (src/audit-detail.ts). Never the raw params.
  detail: AuditDetail;
}

// One field of an audit row's params, labelled in plain English.
export interface AuditField {
  name: string;
  value: string;
}

// One field that differs between a row's `before` and `after`. before is null for a
// field the change added, after is null for one it removed.
export interface AuditChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface AuditDetail {
  // The reason typed with the change, when the row carries one.
  reason: string | null;
  // Field by field, when the row carries a before or an after; null when it carries neither.
  changes: AuditChange[] | null;
  fields: AuditField[];
  // Recorded fields not shown: hashes, signatures and nested values.
  withheld: number;
  // The params are not JSON (rows older than that rule), so nothing can be shown.
  unreadable: boolean;
}

export interface PortalActivity {
  generated: string;
  // id: one row by its id, for the Activity drawer; the namespace and actor filters
  // are then not applied.
  filter: { namespace: string | null; actor: string | null; id: number | null };
  // Newest first, at most `limit`.
  rows: PortalActivityRow[];
  limit: number;
}

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
// request it names is merged or closed), resumed-not-completed (the merge-resume step
// resumed it 24 hours or more ago and it is not done), unchanged (blocked or claimed, and
// its row has not changed in 3 days).
export type StaleRule = "unchanged" | "resumed-not-completed" | "prs-settled";

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
// over the knowledge store (capsid/decisions.md 2026-10-09, Portal review item 4). One of
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

export interface LibraryDocument extends LibraryEntry {
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
  | "rule-docs-not-checked";

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

export interface PlannedJob {
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
