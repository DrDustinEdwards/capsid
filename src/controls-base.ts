import type { PortalAction } from "./ops-types/portal";

// The admin controls' shared vocabulary (src/controls.ts is the core): the action list, the audit
// row names, and the helpers both the plan and the perform read.

export const PORTAL_ACTIONS: readonly PortalAction[] = [
  "pr_close",
  "revoke_agent",
  "activate_agent",
  "site_add",
  "site_edit",
  "site_remove",
  "package_add",
  "package_edit",
  "package_remove",
  "site_repair",
  "site_backup",
  "run_job",
  "namespace_add",
  "namespace_edit",
  "namespace_remove",
  "site_key_rotate",
];

export type ActionParams = Record<string, string | undefined>;

// The click's own audit row is `<prefix><action>`. Rows written before the move to /portal say
// console-<action>; a query across that date names both (docs/schema.md).
const CLICK_AUDIT_PREFIX = "portal-";

// Which front door an action came in by. A click in the Portal and a call to the controls tool are
// the same control; the audit row says which (controls design, section 2): portal-<action> from
// the Portal as it always was, control-<action> from chat.
export type Surface = "portal" | "chat";
const CHAT_AUDIT_PREFIX = "control-";
// Every project thread is the admin, so chat could be talked into any of these by text it read; a click
// in a signed-in browser is a person.
const PORTAL_ONLY: ReadonlySet<PortalAction> = new Set<PortalAction>([
  "site_key_rotate",
  "activate_agent",
]);
export const portalOnlyRefusal = (action: PortalAction, surface: Surface): string | null =>
  surface === "chat" && PORTAL_ONLY.has(action)
    ? `'${action}' runs only from a click in the Portal (https://portal.dustinedwards.info: a site's Setup tab for its key, an agent's drawer to activate it), so text a session read can never set a key or activate one. Nothing was done.`
    : null;

export const auditPrefix = (surface: Surface) =>
  surface === "portal" ? CLICK_AUDIT_PREFIX : CHAT_AUDIT_PREFIX;

export function clickAuditAction(action: PortalAction, surface: Surface = "portal"): string {
  return `${auditPrefix(surface)}${action}`;
}

export const UNKNOWN_ACTION = (action: string) =>
  `unknown Portal action '${action}'. The Portal does: ${PORTAL_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them: a merge can start a deploy and stays behind can_merge, and a mint hands out a key.`;

export function revisionOf(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

export function deleteOptionsFrom(
  params: ActionParams,
):
  | { ok: true; opts: { cascade: boolean; allowImprovePaths: boolean } }
  | { ok: false; refusal: string } {
  for (const key of ["cascade", "allow_improve_paths"] as const) {
    if (params[key] !== undefined && params[key] !== "true")
      return {
        ok: false,
        refusal: `namespace_remove's ${key} is "true" or absent; got '${params[key]}'.`,
      };
  }
  return {
    ok: true,
    opts: {
      cascade: params.cascade === "true",
      allowImprovePaths: params.allow_improve_paths === "true",
    },
  };
}
