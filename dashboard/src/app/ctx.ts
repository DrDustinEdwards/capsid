import { createContext, useContext } from "react";
import type { OpsFeed, PortalAction, PortalPerformed } from "../types";

// Eleven pages, grouped by what a person is doing (the Portal audit and new map, ruled
// 2026-11-06): Needs you and Health; Sites, one page for every site and one for each; Pull
// requests, Jobs and Projects; Activity, Agents, Packages and Library; Settings last, which
// holds preferences only. The ids are internal; the labels are the menu's words (the Queue is
// "Jobs"). There is no redirect for an old address (pre-launch: no legacy shims).
export const VIEWS = [
  { id: "needs", label: "Needs you", key: "y" },
  { id: "health", label: "Health", key: "h" },
  { id: "sites", label: "Sites", key: "s" },
  { id: "prs", label: "Pull requests", key: "p" },
  { id: "queue", label: "Jobs", key: "q" },
  { id: "projects", label: "Projects", key: "o" },
  { id: "activity", label: "Activity", key: "l" },
  { id: "agents", label: "Agents", key: "a" },
  { id: "packages", label: "Packages", key: "k" },
  { id: "library", label: "Library", key: "b" },
  { id: "settings", label: "Settings", key: "e" },
] as const;

// The tabs of each page that has them, in order: the first is the bare address, the rest
// ?tab=<id>. A "page#tab" reference (placePath) names one. A site's own page has its tabs in
// SITE_TABS.
export const HEALTH_TABS = [
  { id: "problems", label: "Problems" },
  { id: "backups", label: "Backups" },
  { id: "ci", label: "CI" },
  { id: "scheduled", label: "Scheduled tasks" },
  { id: "resources", label: "Cloudflare" },
] as const;
export type HealthTab = (typeof HEALTH_TABS)[number]["id"];

export const SITES_TABS = [
  { id: "all", label: "All sites" },
  { id: "deploys", label: "Deploys" },
] as const;

export const QUEUE_TABS = [
  { id: "jobs", label: "Jobs" },
  { id: "checks", label: "Checks" },
] as const;

export const AGENT_TABS = [
  { id: "roster", label: "Agents" },
  { id: "archive", label: "Archive" },
  { id: "access", label: "AI access" },
] as const;

export const PACKAGE_TABS = [
  { id: "published", label: "Published" },
  { id: "shared", label: "Shared" },
  { id: "complete", label: "Completeness" },
] as const;

export const SITE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "deploys", label: "Deploys" },
  { id: "traffic", label: "Search and traffic" },
  { id: "sync", label: "Sync and repairs" },
  { id: "setup", label: "Setup" },
] as const;
export type SiteTab = (typeof SITE_TABS)[number]["id"];

const PAGE_TABS: Partial<Record<(typeof VIEWS)[number]["id"], ReadonlyArray<{ id: string }>>> = {
  health: HEALTH_TABS,
  sites: SITES_TABS,
  queue: QUEUE_TABS,
  agents: AGENT_TABS,
  packages: PACKAGE_TABS,
};

/** The tab a page's ?tab= names, when the page has it; else null. */
export function tabOf<T extends { id: string }>(tabs: ReadonlyArray<T>, name: string | null | undefined): T["id"] | null {
  return name && tabs.some((t) => t.id === name) ? name : null;
}

export type ViewId = (typeof VIEWS)[number]["id"];

export type ViewDef = (typeof VIEWS)[number];
export type DrawerType = "job" | "agent" | "audit";

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
  // The help under the typed version field (TYPED_CONFIRM), when the caller knows which
  // number to type: a policy change signs the version after the one in force.
  confirmHelp?: string;
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

export const NEEDS_REASON: ReadonlySet<PortalAction> = new Set<PortalAction>(["resume_job", "release_job", "fail_job", "close_shipped", "supersede_job", "park_job", "pr_close", "unit_resume", "automerge_resume"]);

// The actions whose dialog also offers an optional note under the reason: resume_job's
// is the full approval, which the driver reads as resume_note.note.
export const TAKES_NOTE: ReadonlySet<PortalAction> = new Set<PortalAction>(["resume_job"]);

// The actions whose dialog asks for the version number typed before the preview (confirm).
export const TYPED_CONFIRM: ReadonlySet<PortalAction> = new Set<PortalAction>(["sign_policy_from_repo", "sign_policy_change"]);

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
  namespace_add: "Add project",
  namespace_edit: "Save changes",
  namespace_remove: "Delete project",
  site_key_rotate: "Rotate key",
};

export function performLabel(action: PortalAction, params: Record<string, string>): string {
  const l = PERFORM_LABEL[action];
  return typeof l === "function" ? l(params) : l;
}

// One-way actions: once the preview arrives, focus goes to Cancel, not to perform.
export const ONE_WAY: ReadonlySet<PortalAction> = new Set<PortalAction>(["revoke_agent", "fail_job", "site_remove", "package_remove", "reset_breaker", "release_job", "close_shipped", "supersede_job", "pr_close", "namespace_remove", "site_key_rotate"]);

// Destructive actions: the perform button is the danger style and sits apart from Cancel.
export const DESTRUCTIVE: ReadonlySet<PortalAction> = new Set<PortalAction>(["revoke_agent", "fail_job", "site_remove", "package_remove", "namespace_remove"]);

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside the app shell");
  return c;
}

// Routes, relative to the /portal base:
//   /                          needs you, the home (design-portal-evaluation.md, DECIDE 1)
//   /<view>                    a view
//   /<view>/<type>/<id>        a view with a drawer open over it (job, agent, audit row)
//   /sites/<namespace>         one site's own page
//   /sites/<namespace>/<type>/<id>  the same with a drawer over it
export interface Route {
  view: ViewId;
  // The site's namespace on a site's own page, else null.
  site: string | null;
  drawer: { type: DrawerType; id: string } | null;
}

export const DRAWER_TYPES: readonly DrawerType[] = ["job", "agent", "audit"];

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
  let site: string | null = null;
  let i = 0;
  if (isView(segs[0])) (view = segs[0]), (i = 1);
  if (view === "sites" && segs[1] !== undefined) (site = segs[1]), (i = 2);
  const type = segs[i] as DrawerType | undefined;
  const id = segs[i + 1];
  return { view, site, drawer: type && DRAWER_TYPES.includes(type) && id ? { type, id } : null };
}

/** The address a page names, or a page and its tab or section as "page#tab": a tab of a page
 *  that has tabs is its ?tab=, anything else a #section on the page. */
export function placePath(id: string): string {
  const [page, anchor] = id.split("#");
  if (!isView(page)) return routePath("needs");
  const tabs = PAGE_TABS[page];
  const tab = tabs ? tabOf(tabs, anchor) : null;
  if (tab) return `${routePath(page)}${tab === tabs![0]!.id ? "" : `?tab=${tab}`}`;
  return `${routePath(page)}${anchor ? `#${anchor}` : ""}`;
}

/** One site's own page, at a tab when one is named. */
export function sitePath(namespace: string, tab?: SiteTab): string {
  return `/sites/${encodeURIComponent(namespace)}${tab && tab !== SITE_TABS[0].id ? `?tab=${tab}` : ""}`;
}

export function routePath(view: ViewId, drawer?: { type: DrawerType; id: string } | null, site?: string | null): string {
  const page = site && view === "sites" ? sitePath(site) : view === "needs" ? "/" : `/${view}`;
  if (drawer) return `${page === "/" ? "/needs" : page}/${drawer.type}/${encodeURIComponent(drawer.id)}`;
  return page;
}
