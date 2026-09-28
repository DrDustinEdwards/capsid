import { createContext, useContext } from "react";
import type { OpsFeed } from "../types";

export const VIEWS = [
  { id: "overview", label: "Overview", key: "o" },
  { id: "sites", label: "Sites", key: "s" },
  { id: "incidents", label: "Incidents", key: "i" },
  { id: "queue", label: "Queue", key: "q" },
  { id: "deploys", label: "Deploys", key: "d" },
  { id: "agents", label: "Agents", key: "a" },
  { id: "backups", label: "Backups", key: "b" },
  { id: "ci", label: "CI and merges", key: "c" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];
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
}

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside the app shell");
  return c;
}

// Routes, relative to the /console/app base:
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
