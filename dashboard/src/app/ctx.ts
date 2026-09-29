import { createContext, useContext } from "react";
import type { OpsFeed, PortalAction, PortalPerformed } from "../types";

export const VIEWS = [
  { id: "overview", label: "Overview", key: "o" },
  { id: "sites", label: "Sites", key: "s" },
  { id: "incidents", label: "Incidents", key: "i" },
  { id: "queue", label: "Queue", key: "q" },
  { id: "deploys", label: "Deploys", key: "d" },
  { id: "agents", label: "Agents", key: "a" },
  { id: "backups", label: "Backups", key: "b" },
  { id: "ci", label: "CI and merges", key: "c" },
  { id: "namespaces", label: "Namespaces", key: "n" },
  { id: "activity", label: "Activity", key: "l" },
  { id: "settings", label: "Settings", key: "e" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

// The views on offer: Sites only while at least one site is configured (hasSites in
// lib/derive.ts). Every other view is always there, Settings included, since that is
// where the first site is added.
export type ViewDef = (typeof VIEWS)[number];
const WITHOUT_SITES: ReadonlyArray<ViewDef> = VIEWS.filter((v) => v.id !== "sites");
export function viewsFor(sites: boolean): ReadonlyArray<ViewDef> {
  return sites ? VIEWS : WITHOUT_SITES;
}
export type DrawerType = "site" | "job" | "agent";

export function isView(v: string | undefined): v is ViewId {
  return VIEWS.some((x) => x.id === v);
}

export interface Filters {
  ns: string;
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
  // Opens the confirm dialog for one control: it previews, then performs on "Do it".
  confirm: (req: ConfirmRequest) => void;
  // The session ended: show the signed-out page.
  signOut: () => void;
}

// One control's request to the confirm dialog. The dialog collects params.reason
// itself for the actions that need one (NEEDS_REASON).
export interface ConfirmRequest {
  action: PortalAction;
  params: Record<string, string>;
  // The dialog's heading before the preview answers, e.g. "Pause sample".
  title: string;
  // Called after a successful perform, once the app has taken the new feed.
  onDone?: (p: PortalPerformed) => void;
}

export const NEEDS_REASON: ReadonlySet<PortalAction> = new Set<PortalAction>(["pause", "resume_job", "release_job", "fail_job"]);

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside the app shell");
  return c;
}

// Routes, relative to the /portal base:
//   /                      overview
//   /<view>                a view
//   /<view>/<type>/<id>    a view with a drawer open over it (site, job, agent)
export interface Route {
  view: ViewId;
  drawer: { type: DrawerType; id: string } | null;
}

const TYPES: DrawerType[] = ["site", "job", "agent"];

export function parseRoute(path: string): Route {
  const segs = path.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      // A malformed escape: keep the raw segment so the route still resolves.
      return s;
    }
  });
  let view: ViewId = "overview";
  let i = 0;
  if (isView(segs[0])) (view = segs[0]), (i = 1);
  const type = segs[i] as DrawerType | undefined;
  const id = segs[i + 1];
  return { view, drawer: type && TYPES.includes(type) && id ? { type, id } : null };
}

export function routePath(view: ViewId, drawer?: { type: DrawerType; id: string } | null): string {
  if (drawer) return `/${view}/${drawer.type}/${encodeURIComponent(drawer.id)}`;
  return view === "overview" ? "/" : `/${view}`;
}
