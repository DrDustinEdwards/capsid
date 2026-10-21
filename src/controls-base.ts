import type { SweepItem } from "./canon";
import type { JobRow } from "./jobs-schema";
import type { PortalAction } from "./ops-types/portal";
import { prUrlsFromJob } from "./outcome-prs";

// The admin controls' shared vocabulary (src/controls.ts is the core): the action list,
// the audit row names, and the helpers both the plan and the perform read.

export const PORTAL_ACTIONS: readonly PortalAction[] = [
  "overnight",
  "resume_job",
  "fail_job",
  "release_job",
  "close_shipped",
  "supersede_job",
  "park_job",
  "unpark_job",
  "pr_close",
  "approve_pr",
  "revoke_agent",
  "site_add",
  "site_edit",
  "site_remove",
  "reset_breaker",
  "package_add",
  "package_edit",
  "package_remove",
  "canon_approve",
  "canon_reject",
  "canon_approve_all",
  "site_repair",
  "sign_policy_change",
  "sign_policy_from_repo",
  "unit_resume",
  "automerge_resume",
];

export type ActionParams = Record<string, string | undefined>;

// The click's own audit row is `<prefix><action>`. Rows written before the move to
// /portal say console-<action>; a query across that date names both (docs/schema.md).
const CLICK_AUDIT_PREFIX = "portal-";

// The automation switch (overnight) takes a reason in both directions, and an Undo
// from the Portal's result message sends the reverse change with undo: "true". Its click row is then `portal-undo-<action>`, so an undo reads as its
// own row, never as a fresh decision (ruled 2026-09-30, DECIDE 5).
export const SWITCHES: ReadonlySet<PortalAction> = new Set<PortalAction>(["overnight"]);
const UNDO_INFIX = "undo-";

// Which front door an action came in by. A click in the Portal and a call to the
// controls tool are the same control; the audit row says which (controls design,
// section 2): portal-<action> from the Portal as it always was, control-<action>
// from chat.
export type Surface = "portal" | "chat";
const CHAT_AUDIT_PREFIX = "control-";
export const auditPrefix = (surface: Surface) => (surface === "portal" ? CLICK_AUDIT_PREFIX : CHAT_AUDIT_PREFIX);

/** The click row's action name: portal-<action>, or portal-undo-<action> for an Undo
 *  (control- for chat). */
export function clickAuditAction(action: PortalAction, params: ActionParams, surface: Surface = "portal"): string {
  return `${auditPrefix(surface)}${params.undo === "true" ? UNDO_INFIX : ""}${action}`;
}

/** What a switch without a reason is told, at preview and again at perform. */
export function switchReasonRefusal(action: PortalAction): string {
  switch (action) {
    case "overnight":
      return "overnight needs a reason: why the overnight run goes on, off, or changes what it runs on. It is recorded in the audit row with the change.";
    default:
      return `${action} needs a reason, recorded in the audit row with the change.`;
  }
}

export const UNKNOWN_ACTION = (action: string) =>
  `unknown Portal action '${action}'. The Portal does: ${PORTAL_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them: a merge can start a deploy and stays behind can_merge, and a mint hands out a key.`;

export function isPortalAction(value: unknown): value is PortalAction {
  return typeof value === "string" && (PORTAL_ACTIONS as readonly string[]).includes(value);
}

/** A revision param as a positive integer, or null. */
export function revisionOf(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

export const UNIT_RESUME_REASON = "unit_resume needs a reason: why the rollback that suspended the unit is answered. It is recorded in the audit row.";
export const AUTOMERGE_RESUME_REASON = "automerge_resume needs a reason: why the rollbacks or reverts that paused the namespace are answered. It is recorded in the audit row.";
export const CANON_REJECT_REASON = "canon_reject needs a reason: the proposer reads it, and a rejection with no reason is one nobody can act on.";

// canon_approve_all's preview, one line per proposal in the order the perform runs them:
// every rejection, then every approval, each by id.
export function sweepOrder(items: readonly SweepItem[]): SweepItem[] {
  return [...items.filter((i) => i.outcome !== "approve"), ...items.filter((i) => i.outcome === "approve")];
}

// close_shipped's complete (stale jobs D4, ruled 2026-10-09: the existing admin_complete
// path, crediting the holder). The pull requests the job names, from result_ref and the
// summary, become the evidence the outcome verifies, at most the 10 the capsid_work_jobs tool takes.
const CLOSE_SHIPPED_MAX_PRS = 10;
export function shippedEvidence(job: JobRow): { result_ref?: string; prs: string[]; more: number } {
  const all = prUrlsFromJob(job);
  const prs = all.slice(0, CLOSE_SHIPPED_MAX_PRS);
  const ref = job.result_ref && prs.includes(job.result_ref) ? job.result_ref : prs[0];
  return { ...(ref ? { result_ref: ref } : {}), prs, more: all.length - prs.length };
}
