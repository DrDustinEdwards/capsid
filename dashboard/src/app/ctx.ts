import { createContext, useContext } from "react";
import type { OpsFeed, PortalAction, PortalPerformed } from "../types";

// Nine pages, regrouped by task (docs/design/design-portal-evaluation.md section 2, DECIDE
// 2 and 8, ruled 2026-10-09; job_d62abdbfc270 PR 2 and PR 7; the Portal UX audit's sitemap,
// 2026-10). Health holds what Overview, Sites, Incidents, Deploys, Backups and CI's
// default-branch table held; Pull requests holds CI's PR half; Agents holds Claims as its
// Checks tab; Packages holds Shared code as its Shared tab; Settings holds the Namespaces
// panel. The ids are internal and stay; only the labels are the audit's words (the Queue is
// "Jobs"). The order is the menu's, Settings last. The letters follow the pages, with no
// redirect period for the old ones (Dustin, 2026-10-09).
export const VIEWS = [
  { id: "needs", label: "Needs you", key: "y" },
  { id: "health", label: "Health", key: "h" },
  { id: "prs", label: "Pull requests", key: "p" },
  { id: "queue", label: "Jobs", key: "q" },
  { id: "activity", label: "Activity", key: "l" },
  { id: "agents", label: "Agents", key: "a" },
  { id: "packages", label: "Packages", key: "k" },
  { id: "library", label: "Library", key: "b" },
  { id: "settings", label: "Settings", key: "e" },
] as const;

// Where each retired view's content lives now, so an old address, an old "view:" reference
// and a bookmark land on the page and section that hold it.
export type MovedId = "overview" | "sites" | "incidents" | "deploys" | "backups" | "ci" | "namespaces" | "claims" | "shared";
export const MOVED: Record<MovedId, { view: (typeof VIEWS)[number]["id"]; anchor?: string; tab?: string }> = {
  overview: { view: "health" },
  sites: { view: "health", tab: "sites" },
  incidents: { view: "health", tab: "problems" },
  deploys: { view: "health", tab: "deploys" },
  backups: { view: "health", tab: "backups" },
  ci: { view: "prs" },
  namespaces: { view: "settings", anchor: "automation" },
  claims: { view: "agents", tab: "claims" },
  shared: { view: "packages", tab: "shared" },
};

// Health's tabs (the UX audit's M1): the verdict and the tiles, then one of these at a
// time, its choice in the address (?tab=). An old section anchor names the tab that holds
// it now, so a bookmark to /health#deploys or a "view:health#ci" reference still lands.
export const HEALTH_TABS = [
  { id: "sites", label: "Sites" },
  { id: "problems", label: "Problems" },
  { id: "deploys", label: "Deploys" },
  { id: "backups", label: "Backups" },
  { id: "ci", label: "CI" },
] as const;
export type HealthTab = (typeof HEALTH_TABS)[number]["id"];
const HEALTH_ALIAS: Record<string, HealthTab> = { incidents: "problems", maintenance: "problems" };
export function healthTab(name: string | null | undefined): HealthTab | null {
  if (!name) return null;
  if (HEALTH_TABS.some((t) => t.id === name)) return name as HealthTab;
  return Object.hasOwn(HEALTH_ALIAS, name) ? HEALTH_ALIAS[name]! : null;
}

export type ViewId = (typeof VIEWS)[number]["id"];

export type ViewDef = (typeof VIEWS)[number];
export type DrawerType = "site" | "job" | "agent" | "audit";

export function isView(v: string | undefined): v is ViewId {
  return VIEWS.some((x) => x.id === v);
}

// The namespace filter is not here: each view keeps its own in the address (?ns=),
// through useNsFilter in views/shared.tsx.
export interface Filters {
  q: string;
  range: "24h" | "7d" | "30d";
}

export interface Ctx {
  feed: OpsFeed;
  now: number;
  view: ViewId;
  open: (ref: string) => void;
  go: (view: ViewId) => void;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  copy: (text: string) => void;
  // A short message in the toast.
  say: (msg: string) => void;
  // Opens the confirm dialog for one control: it previews, then performs on the button
  // named for the action (performLabel).
  confirm: (req: ConfirmRequest) => void;
  // A performed action: takes its feed and shows its result in the message region,
  // which stays until dismissed or replaced by the next action. An automation switch
  // passes its reverse change as undo, and the message offers Undo.
  performed: (p: PortalPerformed, undo?: UndoRequest) => void;
  // The session ended: show the signed-out page.
  signOut: () => void;
}

// One control's request to the confirm dialog. The dialog collects params.reason
// itself for the actions that need one (NEEDS_REASON).
export interface ConfirmRequest {
  action: PortalAction;
  params: Record<string, string>;
  // The dialog's heading before the preview answers, in plain words, e.g. "Pause sample"
  // or "Resume job: <its title>". Raw ids stay in the drawer.
  title: string;
  // Called after a successful perform, once the app has taken the new feed.
  onDone?: (p: PortalPerformed) => void;
  // The reverse action the result message offers as Undo, for a reversible control
  // (park and unpark).
  undo?: UndoRequest;
  // Several rows of one kind decided together (Needs you's batch approve): each item is
  // the same single control with its own params, previewed on its own and listed in this
  // one dialog, then performed one after another. action and params above are the first
  // item's. No item takes a reason.
  batch?: ReadonlyArray<BatchItem>;
}

export interface BatchItem {
  action: PortalAction;
  params: Record<string, string>;
  // The row in plain words, e.g. "sample-org/sample-a #12".
  label: string;
}

// The reverse of a switch change, sent by the message's Undo as its own action, with
// params.undo "true" so the Worker writes portal-undo-<action>. focus is the id of the
// switch that focus returns to.
export interface UndoRequest {
  action: PortalAction;
  params: Record<string, string>;
  focus?: string;
}

export const NEEDS_REASON: ReadonlySet<PortalAction> = new Set<PortalAction>(["resume_job", "release_job", "fail_job", "close_shipped", "supersede_job", "park_job", "pr_close"]);

// The actions whose dialog also offers an optional note under the reason: resume_job's
// is the full approval, which the driver reads as resume_note.note.
export const TAKES_NOTE: ReadonlySet<PortalAction> = new Set<PortalAction>(["resume_job"]);

// The actions whose dialog asks for the version number typed before the preview (confirm).
export const TYPED_CONFIRM: ReadonlySet<PortalAction> = new Set<PortalAction>(["sign_policy_from_repo"]);

// The confirm dialog's perform button, named for what it does (audit DECIDE 11).
const PERFORM_LABEL: Record<PortalAction, string | ((p: Record<string, string>) => string)> = {
  overnight: (p) => (p.value === "off" ? "Turn off" : p.value === "subscription" ? "Run on subscription" : "Run on API key"),
  resume_job: "Resume job",
  release_job: "Release job",
  fail_job: "Mark failed",
  close_shipped: "Close as shipped",
  supersede_job: "Supersede job",
  park_job: "Park job",
  unpark_job: "Unpark job",
  pr_close: "Close pull request",
  approve_pr: (p) => (p.undo === "true" ? "Undo approval" : "Approve"),
  revoke_agent: "Revoke agent",
  site_add: "Add site",
  site_edit: "Save changes",
  site_remove: "Remove site",
  reset_breaker: "Reset and resume",
  package_add: "Add package",
  package_edit: "Save changes",
  package_remove: "Remove package",
  site_repair: (p) => `Run ${p.tool ?? "repair"}`,
  sign_policy_change: (p) => (p.change === "demote" ? "Sign without the unit" : "Sign and promote"),
  sign_policy_from_repo: "Load from repo and sign",
  unit_resume: "Lift suspension",
  automerge_resume: "Resume auto-merge",
};

export function performLabel(action: PortalAction, params: Record<string, string>): string {
  const l = PERFORM_LABEL[action];
  return typeof l === "function" ? l(params) : l;
}

// One-way actions: once the preview arrives, focus goes to Cancel, not to perform.
export const ONE_WAY: ReadonlySet<PortalAction> = new Set<PortalAction>(["revoke_agent", "fail_job", "site_remove", "package_remove", "reset_breaker", "release_job", "close_shipped", "supersede_job", "pr_close"]);

// Destructive actions: the perform button is the danger style and sits apart from Cancel.
export const DESTRUCTIVE: ReadonlySet<PortalAction> = new Set<PortalAction>(["revoke_agent", "fail_job", "site_remove", "package_remove"]);

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside the app shell");
  return c;
}

// Routes, relative to the /portal base:
//   /                      needs you, the home (design-portal-evaluation.md, DECIDE 1)
//   /<view>                a view
//   /<view>/<type>/<id>    a view with a drawer open over it (site, job, agent, audit row)
export interface Route {
  view: ViewId;
  drawer: { type: DrawerType; id: string } | null;
}

const TYPES: DrawerType[] = ["site", "job", "agent", "audit"];

export function parseRoute(path: string): Route {
  const segs = path.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      // A malformed escape: keep the raw segment so the route still resolves.
      return s;
    }
  });
  let view: ViewId = "needs";
  let i = 0;
  if (isView(segs[0])) (view = segs[0]), (i = 1);
  else if (segs[0] !== undefined && Object.hasOwn(MOVED, segs[0])) (view = MOVED[segs[0] as MovedId].view), (i = 1);
  const type = segs[i] as DrawerType | undefined;
  const id = segs[i + 1];
  return { view, drawer: type && TYPES.includes(type) && id ? { type, id } : null };
}

/** The address an old view id or a current one names: its page, with the section's anchor
 *  or the tab's query when it moved into one. A current id may name its section itself,
 *  as "health#ci", which on Health is a tab. */
export function placePath(id: string): string {
  const [page, anchor] = id.split("#");
  if (isView(page)) {
    const tab = page === "health" ? healthTab(anchor) : null;
    if (tab) return `${routePath(page)}?tab=${tab}`;
    return `${routePath(page)}${anchor ? `#${anchor}` : ""}`;
  }
  const moved = Object.hasOwn(MOVED, id) ? MOVED[id as MovedId] : null;
  if (!moved) return routePath("needs");
  return `${routePath(moved.view)}${moved.tab ? `?tab=${moved.tab}` : ""}${moved.anchor ? `#${moved.anchor}` : ""}`;
}

export function routePath(view: ViewId, drawer?: { type: DrawerType; id: string } | null): string {
  if (drawer) return `/${view}/${drawer.type}/${encodeURIComponent(drawer.id)}`;
  return view === "needs" ? "/" : `/${view}`;
}
