import type { OpsFeed } from "./feed";

// Preview writes nothing and returns a signed token; perform carries only the token. Both are JSON
// POSTs with X-Capsid-CSRF. A refusal is text/plain: 400 refused or invalid, 403 CSRF or
// cross-site, 410 token expired, 413 body too large.

export type PortalAction =
  | "pr_close"
  | "revoke_agent"
  | "site_add"
  | "site_edit"
  | "site_remove"
  | "package_add"
  | "package_edit"
  | "package_remove"
  | "site_repair"
  | "site_backup"
  | "run_job"
  | "namespace_add"
  | "namespace_edit"
  | "namespace_remove"
  | "activate_agent"
  | "site_key_rotate";

// Params are by action.
export interface PortalActionRequest {
  action: PortalAction;
  params: Record<string, string>;
}

export interface PortalPreview {
  action: PortalAction;
  summary: string;
  changes: string[];
  audit: string[];
  token: string;
  expires_at: string;
}

export interface PortalPerformed {
  action: PortalAction;
  summary: string;
  warning: string | null;
  feed: OpsFeed;
}

export interface PortalNamespace {
  namespace: string;
  // Null means no truth report was ever run, which is not an integrity of zero.
  latest_report: { integrity: number | null; generated: string } | null;
  repos: Array<{ repo: string; label: string }>;
}

export interface PortalNamespaces {
  generated: string;
  namespaces: PortalNamespace[];
}

export interface PortalActivityRow {
  id: number;
  at: string;
  actor: string | null;
  client: string | null;
  action: string | null;
  namespace: string | null;
  path: string | null;
  detail: AuditDetail;
}

export interface AuditField {
  name: string;
  value: string;
}

export interface AuditChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface AuditDetail {
  reason: string | null;
  changes: AuditChange[] | null;
  fields: AuditField[];
  withheld: number;
  unreadable: boolean;
}

export interface PortalActivity {
  generated: string;
  filter: { namespace: string | null; actor: string | null; id: number | null };
  rows: PortalActivityRow[];
  limit: number;
}
