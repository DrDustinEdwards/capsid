import type { OpsFeed } from "./feed";

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
  | "site_repair"
  // The merge units (docs/design/design-merge-pipeline.md section 7): a signed policy
  // change that promotes or removes a unit, and the Undo of a unit's suspension.
  | "sign_policy_change"
  // Write the auto-merge policy from docs/policy/auto-merge.md on the default branch and
  // sign it (src/policy-sign.ts, planPolicyFromRepo).
  | "sign_policy_from_repo"
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
  // The queue's circuit breaker: open after the threshold of holder fails in 24 hours,
  // until reset. since is the window's start in audit_log's UTC format.
  breaker: { open: boolean; failed: number; threshold: number; since: string; reset_at: string | null };
  // Null means no truth report was ever run, which is not an integrity of zero.
  latest_report: { integrity: number | null; generated: string } | null;
  jobs: { queued: number; claimed: number; blocked: number; done_today: number };
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

// One field of an audit row's params, labeled in plain English.
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
