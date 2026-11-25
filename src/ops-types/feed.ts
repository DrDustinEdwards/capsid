import type {
  Inbox as CapsomerInbox,
  InboxApp as CapsomerInboxApp,
  InboxItem as CapsomerInboxItem,
} from "capsomer/behavior/attention-list";
import type { OpsSiteConfig, OpsPackageConfig, OpsSnapshot } from "./sites";

export type OpsJobStatus =
  | "queued"
  | "claimed"
  | "blocked"
  | "done"
  | "failed"
  | "superseded"
  | "parked";

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
  waits_on: string | null;
  command: string | null;
  // "mismatch" withholds the command (null); "legacy-unsigned" is a block from before signing.
  command_signature: "verified" | "legacy-unsigned" | "mismatch" | "unconfigured" | null;
  // Optional so a feed written before it, and the app's sample data, stay valid.
  question?: boolean;
  parked_reason?: string;
  started_by?: string;
  started_at?: string;
  result_ref: string | null;
  finding: { fingerprint: string; seen_count: number | null; last_seen: string | null } | null;
}

export interface OpsAgent {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  pending: boolean;
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
  class?: "auto" | "approve" | "typed" | "seat" | "wait" | null;
  path_class?: string | null;
  class_reasons?: string[];
  head_sha?: string;
  visual?: { title: string; preview: string | null; shots: string[] };
}

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

export interface SharedCodeApp {
  namespace: string;
  name: string;
  system: string | null;
  repo: string | null;
  where: string;
  pinned: string | null;
  behind: number | null;
  via_old_name: boolean;
}

export interface SharedCodePackage {
  name: string;
  repo: string;
  registry: "git" | "npm";
  latest: string | null;
  tags_error: string | null;
  version: string | null;
  untagged: boolean;
  private: boolean;
  npm_latest: string | null;
  npm_note: string | null;
  manifest_error: string | null;
  users: SharedCodeApp[];
  behind: number;
  local_copies: Array<{ namespace: string; path: string; present: boolean | null }>;
  local_left: number;
}

export interface SharedCodeView {
  generated: string;
  configured: boolean;
  error: string | null;
  // How many apps were read, so "nobody is behind" is never "nothing was read".
  apps_read: number;
  apps_failed: Array<{ namespace: string; system?: string | null; error: string }>;
  packages: SharedCodePackage[];
  no_bloat_off?: Array<{ namespace: string; repo: string | null; line: string }>;
}

// "unmeasured": a check could not measure the cell; never a pass or a failure.
export type CompletenessStatus = "complete" | "partial" | "missing" | "unmeasured" | "n/a";

export interface CompletenessCell {
  status: CompletenessStatus;
  reason: string;
  evidence: string[];
  clean_days: number | null;
  errors: Array<{ check: string; detail: string }>;
}

export interface CompletenessArea {
  id: number;
  name: string;
  builder: string;
  verifier: string | null;
  lines: { prs: number; added: number; removed: number } | { error: string } | null;
  cells: Record<string, CompletenessCell>;
}

export interface CompletenessView {
  read: string;
  as_of: string | null;
  error: string | null;
  finished: boolean;
  public_token: boolean;
  sites: Array<{ id: string; name: string; origin: string }>;
  areas: CompletenessArea[];
}

export type { InboxSeverity } from "capsomer/behavior/attention-list";
export type InboxKind =
  | "blocked-job"
  | "question"
  | "pr"
  | "ci"
  | "site-down"
  | "report"
  | "proposal"
  | "stale-claim"
  | "parked-due";
export type InboxItem = CapsomerInboxItem<InboxKind>;
export type InboxApp = CapsomerInboxApp<InboxKind>;
export type Inbox = CapsomerInbox<InboxKind>;

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

type OpsMergePolicy =
  | { loads: true; version: string; enabled: boolean; units: string[] }
  | { loads: false; reason: string };

export interface OpsLive {
  generated: string;
  jobs: OpsJob[];
  agents: OpsAgent[];
  prs: OpsPr[];
  awaiting_seat: OpsAwaitingSeat[];
  merge_safety: OpsMergeSafety | null;
  merge_policy: OpsMergePolicy;
  overnight: OpsOvernight;
  namespaces: Array<{ name: string }>;
  sites: OpsSiteConfig[];
  packages: OpsPackageConfig[];
  store: { size_bytes: number | null; cap_bytes: number };
  inbox: Inbox;
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
  evidence: string[];
}

export type OpsTaskRunOutcome = "ok" | "skipped" | "refused" | "threw";

export interface OpsTaskRun {
  started_at: string;
  finished_at: string;
  outcome: OpsTaskRunOutcome;
  reason: string;
}

export interface OpsTask {
  id: string;
  label: string;
  period_ms: number | null;
  flag: "failing" | "quiet" | "never" | null;
  recent: OpsTaskRun[];
}

export interface OpsUptimeCounts {
  probes: number;
  up: number;
  days: number;
  below: number;
}
export interface OpsUptime {
  target: number;
  days: number;
  sites: Array<
    { namespace: string; months: Array<{ month: string } & OpsUptimeCounts> } & OpsUptimeCounts
  >;
}

export interface OpsFeed {
  snapshot: OpsSnapshot | null;
  uptime?: OpsUptime | null;
  live: OpsLive;
  scheduled: { tasks: OpsTask[]; error: null } | { tasks: null; error: string };
  refresh_allowed_at: string | null;
  cloudflare_configured: boolean;
  // Double-submit CSRF value, also in the HttpOnly capsid_portal_csrf cookie and sent back as
  // X-Capsid-CSRF. A cross-site page cannot read this body.
  csrf: string;
  // Who is signed in, for the top bar: from the session, never from configuration.
  user: { name: string; initials: string };
}

type ResourceUser = { script: string; system: string | null; binding: string };

// Names, never values. Private.
export interface ResourcesDoc {
  version: 1;
  read_at: string;
  workers: Array<{
    script: string;
    system: string | null;
    error: string | null;
    secrets: string[];
    vars: string[];
    d1: Array<{ binding: string; database: string }>;
    kv: Array<{ binding: string; namespace: string }>;
    r2: Array<{ binding: string; bucket: string }>;
    durable_objects: Array<{ binding: string; class: string; script: string | null }>;
    queues: Array<{ binding: string; queue: string }>;
    services: Array<{ binding: string; service: string }>;
    other: Array<{ binding: string; kind: string }>;
    previews: Array<{ binding: string; store: string }>;
  }>;
  databases: Array<{
    name: string;
    tables: string[] | null;
    tables_error: string | null;
    used_by: ResourceUser[];
  }>;
  kv_namespaces: Array<{ title: string; used_by: ResourceUser[] }>;
  buckets: Array<{ name: string; used_by: ResourceUser[] }>;
  problems: string[];
}
