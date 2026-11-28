import { createContext, useContext } from "react";
import type { OpsFeed, PortalAction, PortalPerformed } from "../types";

export const VIEWS = [
  { id: "needs", label: "Needs you", key: "y" },
  { id: "health", label: "Health", key: "h" },
  { id: "sites", label: "Sites", key: "s" },
  { id: "prs", label: "Pull requests", key: "p" },
  { id: "projects", label: "Projects", key: "o" },
  { id: "activity", label: "Activity", key: "l" },
  { id: "agents", label: "Agents", key: "a" },
  { id: "packages", label: "Packages", key: "k" },
  { id: "library", label: "Library", key: "b" },
  { id: "settings", label: "Settings", key: "e" },
] as const;

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
  agents: AGENT_TABS,
  packages: PACKAGE_TABS,
};

export function tabOf<T extends { id: string }>(
  tabs: ReadonlyArray<T>,
  name: string | null | undefined,
): T["id"] | null {
  return name && tabs.some((t) => t.id === name) ? name : null;
}

export type ViewId = (typeof VIEWS)[number]["id"];

export type ViewDef = (typeof VIEWS)[number];
export type DrawerType = "agent" | "audit";

function isView(v: string | undefined): v is ViewId {
  return VIEWS.some((x) => x.id === v);
}

export interface Filters {
  q: string;
  range: "24h" | "7d" | "30d";
}

export interface Ctx {
  feed: OpsFeed;
  now: number;
  view: ViewId;
  open: (ref: string) => void;
  href: (ref: string) => string;
  go: (view: ViewId) => void;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  copy: (text: string) => void;
  say: (msg: string) => void;
  confirm: (req: ConfirmRequest) => void;
  performed: (p: PortalPerformed) => void;
  signOut: () => void;
}

export interface ConfirmRequest {
  action: PortalAction;
  params: Record<string, string>;
  title: string;
  onDone?: (p: PortalPerformed) => void;
}

export const NEEDS_REASON: ReadonlySet<PortalAction> = new Set<PortalAction>(["pr_close"]);

const PERFORM_LABEL: Record<PortalAction, string | ((p: Record<string, string>) => string)> = {
  pr_close: "Close pull request",
  revoke_agent: "Revoke agent",
  activate_agent: "Activate agent",
  site_add: "Add site",
  site_edit: "Save changes",
  site_remove: "Remove site",
  package_add: "Add package",
  package_edit: "Save changes",
  package_remove: "Remove package",
  site_repair: (p) => `Run ${p.tool ?? "repair"}`,
  site_backup: (p) => (p.namespace ? `Back up ${p.namespace} now` : "Back up every site now"),
  run_job: (p) => `Run ${p.name ?? "job"} now`,
  namespace_add: "Add project",
  namespace_edit: "Save changes",
  namespace_remove: "Delete project",
  site_key_rotate: "Rotate key",
};

export function performLabel(action: PortalAction, params: Record<string, string>): string {
  const l = PERFORM_LABEL[action];
  return typeof l === "function" ? l(params) : l;
}

export const ONE_WAY: ReadonlySet<PortalAction> = new Set<PortalAction>([
  "revoke_agent",
  "site_remove",
  "package_remove",
  "pr_close",
  "namespace_remove",
  "site_key_rotate",
]);

export const DESTRUCTIVE: ReadonlySet<PortalAction> = new Set<PortalAction>([
  "revoke_agent",
  "site_remove",
  "package_remove",
  "namespace_remove",
]);

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside the app shell");
  return c;
}

export interface Route {
  view: ViewId;
  site: string | null;
  drawer: { type: DrawerType; id: string } | null;
}

export const DRAWER_TYPES: readonly DrawerType[] = ["agent", "audit"];

export function parseRoute(path: string): Route {
  const segs = path
    .split("/")
    .filter(Boolean)
    .map((s) => {
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
  if (isView(segs[0])) {
    view = segs[0];
    i = 1;
  }
  if (view === "sites" && segs[1] !== undefined) {
    site = segs[1];
    i = 2;
  }
  const type = segs[i] as DrawerType | undefined;
  const id = segs[i + 1];
  return { view, site, drawer: type && DRAWER_TYPES.includes(type) && id ? { type, id } : null };
}

export function placePath(id: string): string {
  const [page, anchor] = id.split("#");
  if (!isView(page)) return routePath("needs");
  const tabs = PAGE_TABS[page];
  const tab = tabs ? tabOf(tabs, anchor) : null;
  if (tab) return `${routePath(page)}${tab === tabs![0]!.id ? "" : `?tab=${tab}`}`;
  return `${routePath(page)}${anchor ? `#${anchor}` : ""}`;
}

export function sitePath(namespace: string, tab?: SiteTab): string {
  return `/sites/${encodeURIComponent(namespace)}${tab && tab !== SITE_TABS[0].id ? `?tab=${tab}` : ""}`;
}

export function refPath(ref: string, view: ViewId, site?: string | null): string {
  const i = ref.indexOf(":");
  const type = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (type === "view") return placePath(id);
  if (type === "site") return sitePath(id);
  if ((DRAWER_TYPES as readonly string[]).includes(type))
    return routePath(view, { type: type as DrawerType, id }, site);
  return routePath(view, null, site);
}

export function routePath(
  view: ViewId,
  drawer?: { type: DrawerType; id: string } | null,
  site?: string | null,
): string {
  const page = site && view === "sites" ? sitePath(site) : view === "needs" ? "/" : `/${view}`;
  if (drawer)
    return `${page === "/" ? "/needs" : page}/${drawer.type}/${encodeURIComponent(drawer.id)}`;
  return page;
}
