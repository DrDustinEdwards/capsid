import { createContext, useContext } from "react";
import type { OpsFeed, PortalAction, PortalPerformed } from "../types";

export const VIEWS = [
  { id: "needs", label: "Needs you", key: "y" },
  { id: "overview", label: "Overview", key: "o" },
  { id: "sites", label: "Sites", key: "s" },
  { id: "packages", label: "Packages", key: "p" },
  { id: "incidents", label: "Incidents", key: "i" },
  { id: "queue", label: "Queue", key: "q" },
  { id: "deploys", label: "Deploys", key: "d" },
  { id: "agents", label: "Agents", key: "a" },
  { id: "backups", label: "Backups", key: "b" },
  { id: "ci", label: "CI and merges", key: "c" },
  { id: "namespaces", label: "Namespaces", key: "n" },
  { id: "activity", label: "Activity", key: "l" },
  { id: "claims", label: "Claims", key: "v" },
  { id: "settings", label: "Settings", key: "e" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

// The views on offer: Sites only while at least one site is configured, Packages only
// while a package is (hasSites and hasPackages in lib/derive.ts). Every other view is
// always there, Settings included, since that is where the first of each is added.
export type ViewDef = (typeof VIEWS)[number];
export function viewsFor(sites: boolean, packages = true): ReadonlyArray<ViewDef> {
  return VIEWS.filter((v) => (v.id !== "sites" || sites) && (v.id !== "packages" || packages));
}
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
}

// The reverse of a switch change, sent by the message's Undo as its own action, with
// params.undo "true" so the Worker writes portal-undo-<action>. focus is the id of the
// switch that focus returns to.
export interface UndoRequest {
  action: PortalAction;
  params: Record<string, string>;
  focus?: string;
}

export const NEEDS_REASON: ReadonlySet<PortalAction> = new Set<PortalAction>(["pause", "resume_job", "release_job", "fail_job", "close_shipped", "canon_reject"]);

// The actions whose dialog also offers an optional note under the reason: resume_job's
// is the full approval, which the driver reads as resume_note.note.
export const TAKES_NOTE: ReadonlySet<PortalAction> = new Set<PortalAction>(["resume_job"]);

// The confirm dialog's perform button, named for what it does (audit DECIDE 11).
const PERFORM_LABEL: Record<PortalAction, string | ((p: Record<string, string>) => string)> = {
  pause: "Pause",
  unpause: "Unpause",
  mode: "Set mode",
  seat_start: (p) => (p.value === "off" ? "Turn off" : "Turn on"),
  overnight: (p) => (p.value === "off" ? "Turn off" : p.value === "subscription" ? "Run on subscription" : "Run on API key"),
  resume_job: "Resume job",
  release_job: "Release job",
  fail_job: "Mark failed",
  close_shipped: "Close as shipped",
  revoke_agent: "Revoke agent",
  site_add: "Add site",
  site_edit: "Save changes",
  site_remove: "Remove site",
  reset_breaker: "Reset breaker",
  package_add: "Add package",
  package_edit: "Save changes",
  package_remove: "Remove package",
  canon_approve: "Approve and write",
  canon_reject: "Reject proposal",
  site_repair: (p) => `Run ${p.tool ?? "repair"}`,
};

export function performLabel(action: PortalAction, params: Record<string, string>): string {
  const l = PERFORM_LABEL[action];
  return typeof l === "function" ? l(params) : l;
}

// One-way actions: once the preview arrives, focus goes to Cancel, not to perform.
export const ONE_WAY: ReadonlySet<PortalAction> = new Set<PortalAction>(["revoke_agent", "fail_job", "site_remove", "package_remove", "reset_breaker", "release_job", "close_shipped", "canon_approve", "canon_reject"]);

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
  const type = segs[i] as DrawerType | undefined;
  const id = segs[i + 1];
  return { view, drawer: type && TYPES.includes(type) && id ? { type, id } : null };
}

export function routePath(view: ViewId, drawer?: { type: DrawerType; id: string } | null): string {
  if (drawer) return `/${view}/${drawer.type}/${encodeURIComponent(drawer.id)}`;
  return view === "needs" ? "/" : `/${view}`;
}
