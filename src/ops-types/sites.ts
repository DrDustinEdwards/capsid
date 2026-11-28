// Types only, no runtime code, so the dashboard app imports it with `import type` and src/ never
// imports from the app.

export type ProbeState = "ok" | "degraded" | "liveness" | "down";
type CheckState = "clear" | "finding" | "could-not-run";

export interface SiteProbe {
  namespace: string;
  name: string;
  origin: string;
  health_path: string | null;
  platform: "cloudflare" | "vercel";
  state: ProbeState;
  http_status: number | null;
  latency_ms: number | null;
  sha: string | null;
  error: string | null;
  checked_at: string;
}

export interface CfDeploy {
  id: string;
  created_on: string;
  version_id: string | null;
  message: string | null;
  triggered_by: string | null;
  author_email: string | null;
}

export interface HourBucket {
  hour: string;
  requests: number;
  errors: number;
  cpu_ms: number;
}

// Every state but "ok" is no data, with its reason, never zero.
export type SiteCloudflare =
  | { state: "no-token"; reason: string }
  | { state: "not-cloudflare"; reason: string }
  | { state: "unresolved"; reason: string }
  | { state: "error"; reason: string }
  | {
      state: "ok";
      script: string;
      deploys: CfDeploy[];
      errors24: HourBucket[] | null;
      errors_reason: string | null;
    };

export interface SiteSnapshot extends SiteProbe {
  ring: string;
  ring_slot: number;
  cloudflare?: SiteCloudflare;
}

export interface CiObservation {
  namespace: string;
  latest: {
    head_sha: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    url: string | null;
  } | null;
}

export interface OffaccountObservation {
  reported_at: string | null;
  sites: Array<{ site: string; newest: string | null }>;
  last_run: { at: string | null; conclusion: string | null; url: string | null } | null;
  last_drill: { at: string | null; conclusion: string | null; url: string | null } | null;
}

export interface SiteMapDrift {
  unmapped: string[];
  unknown: string[];
}

export interface OpsSiteConfig {
  namespace: string;
  name: string;
  origin: string | null;
  health_path: string | null;
  platform: "cloudflare" | "vercel" | null;
  script: string | null;
  // Probed in-process rather than over HTTP: Capsid's own row. Not settable from the Portal.
  self_probe: boolean;
  revision: number;
  updated_at: string;
  operator: SiteOperator | null;
  operator_problem: string | null;
}

export interface SiteOperator {
  path: string;
  auth_var: string;
  repairs: Record<string, string>;
  weekly: string[];
  secrets: string[];
  backup: boolean;
}

export interface HealthSnapshot {
  status: "ok" | "degraded";
  sha: string;
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
  offaccount: OffaccountObservation | null;
  ci: CiObservation[];
  site_map: SiteMapDrift | null;
  sites: SiteSnapshot[];
  expiry?: ExpirySnapshot;
}

export interface ExpirySnapshot {
  tls: {
    read_at: string;
    hosts: Array<{ host: string; expires: string }>;
    failed: Array<{ host: string; error: string }>;
  } | null;
  domains: {
    read_at: string;
    domains: Array<{ domain: string; expires: string }>;
    failed: Array<{ domain: string; error: string }>;
  } | null;
}

export interface OpsPackageConfig {
  name: string;
  registry: "npm";
  repo: string | null;
  formerly: string | null;
  revision: number;
  updated_at: string;
}

export interface PortalNotFound {
  days: number;
  generated: string;
  pages: Array<{
    path: string;
    hits: number;
    referrers: Array<{ host: string; hits: number }>;
  }> | null;
  probes: number | null;
  error: string | null;
}

export interface ServerErrors {
  count: number;
  top: Array<{ path: string; status: number; hits: number }>;
}
