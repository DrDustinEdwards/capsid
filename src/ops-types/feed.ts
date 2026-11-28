import type {
  Inbox as CapsomerInbox,
  InboxApp as CapsomerInboxApp,
  InboxItem as CapsomerInboxItem,
} from "capsomer/behavior/attention-list";
import type { OpsSiteConfig, OpsPackageConfig, OpsSnapshot } from "./sites";

export interface OpsAgent {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  pending: boolean;
  archived_at: string | null;
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
export type InboxKind = "ci" | "site-down" | "report";
export type InboxItem = CapsomerInboxItem<InboxKind>;
export type InboxApp = CapsomerInboxApp<InboxKind>;
export type Inbox = CapsomerInbox<InboxKind>;

export interface OpsLive {
  generated: string;
  agents: OpsAgent[];
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
  class: "alert" | "digest" | "attention";
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
