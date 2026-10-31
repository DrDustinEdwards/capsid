// The Watch Floor contract: what GET /portal/api/ops returns
// (capsid/research/design-ops-console.md). Types only, no runtime code, so the
// dashboard app under dashboard/ imports it with `import type` and src/ never imports
// from the app. Changing a field here changes both sides, and both typecheck against it.

export type ProbeState = "ok" | "degraded" | "liveness" | "down";
type CheckState = "clear" | "finding" | "could-not-run";

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
  // Billed CPU time, in milliseconds.
  cpu_ms: number;
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
type PackagePart<T> = ({ state: "ok" } & T) | { state: "none"; reason: string } | { state: "error"; reason: string };

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

/** One site's returned 5xx over an hour: the count, and the busiest path and status pairs
 *  behind it, so a finding names where the errors are and not only how many. */
export interface ServerErrors {
  count: number;
  top: Array<{ path: string; status: number; hits: number }>;
}
