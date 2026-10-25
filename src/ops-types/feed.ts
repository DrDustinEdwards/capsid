import type { OpsSiteConfig, OpsPackageConfig, OpsSnapshot } from "./sites";

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
  // A pull request labeled visual (src/visual-pr.ts): its title, the live preview its
  // description names, and its screenshots, all read from the pull request itself.
  visual?: { title: string; preview: string | null; shots: string[] };
}

// The overnight run's switch (src/overnight.ts). decision is present only while the mode is
// subscription: who decided, when, the ruling and its reasoning, and who set the switch.
interface OpsOvernight {
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
  // The version in the package repo's root package.json on its default branch; null when
  // it has none or the file was not read (manifest_error says why).
  version: string | null;
  // True when the tags were read and none names that version: the daily maintenance pass
  // tags it (src/maintenance-releases.ts). False when it is tagged or this is unknown.
  untagged: boolean;
  // "private": true in that package.json: never published, so npm is not asked.
  private: boolean;
  // npm's latest dist-tag, or null with npm_note saying why (not on npm, unread); both
  // null for a private package.
  npm_latest: string | null;
  npm_note: string | null;
  manifest_error: string | null;
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

type OpsMergePolicy = { loads: true; version: string; enabled: boolean } | { loads: false; reason: string };

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
  // Whether the signed auto-merge policy loads as the tick loads it (loadMergePolicy), and
  // if not why, so the Portal's policy panel can say so beside its sign-from-repo button.
  merge_policy: OpsMergePolicy;
  overnight: OpsOvernight;
  // Sessions with no SessionEnd whose last event was in the last 24 hours, newest
  // first, at most 50.
  sessions: OpsSession[];
  // Every app roster namespace (APP_ROSTER in src/roster.ts), read from code. The
  // per-namespace detail is GET /portal/api/namespaces, read when the Namespaces view
  // opens.
  namespaces: Array<{ name: string }>;
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
  // The watcher's open findings that post no job (src/watcher-checks.ts, findingClass): class
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
