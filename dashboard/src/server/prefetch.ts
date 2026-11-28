import { QueryClient, dehydrate, type DehydratedState } from "@tanstack/react-query";
import { createContext, type RouterContextProvider } from "react-router";
import { answerOf, ask, type Answer } from "capsomer/react/data";
import { FEED_KEY, LIVE } from "../lib/api";
import { pageBase } from "../lib/router";
import type { FigureSet, OpsFeed } from "../types";
import { figuresKey } from "../lib/trends";
import type { ViewId } from "../app/ctx";
import { PUSH_KEY, parseDocParam } from "../lib/keys";

// A new QueryClient per request, dehydrated into the HTML so the first render carries every read.
// Keys must match the views' useAnswer calls, or the view will not find the prefetched read.

export type PortalRead = (path: string) => Promise<Response>;

export interface PortalServer {
  read: PortalRead;
  nonce: string;
}

// One key for the whole process on globalThis: src/worker.ts sets it and the server build reads it, and each carries its own copy of this module.
const KEY = Symbol.for("capsid-portal.server");
const shared = globalThis as { [KEY]?: ReturnType<typeof createContext<PortalServer | null>> };
export const portalServer = (shared[KEY] ??= createContext<PortalServer | null>(null));

function serverFor(context: Readonly<RouterContextProvider>, request: Request): PortalServer {
  const given = context.get(portalServer);
  if (given) return given;
  const cookie = request.headers.get("cookie");
  return {
    nonce: "",
    read: (path) =>
      fetch(new URL(`/portal/api${path}`, request.url), {
        headers: cookie ? { cookie, accept: "application/json" } : { accept: "application/json" },
      }),
  };
}

export function nonceFor(context: Readonly<RouterContextProvider>): string {
  return context.get(portalServer)?.nonce ?? "";
}

interface Spec {
  key: readonly unknown[];
  path: string;
}

const qs = (o: Record<string, string>) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  return s ? `?${s}` : "";
};

function specsFor(
  view: ViewId,
  url: URL,
  feed: OpsFeed | null,
  demo: boolean,
  drawer: { type: string; id: string } | null,
  site: string | null,
): Spec[] {
  const p = url.searchParams;
  const trends: Spec = { key: [LIVE, "trends"], path: "/trends" };
  const namespaces: Spec = { key: [LIVE, "namespaces"], path: "/namespaces" };
  const figures = (set: FigureSet): Spec => ({ key: figuresKey(set), path: `/figures?set=${set}` });
  const out: Spec[] = [];
  switch (view) {
    case "board":
      out.push(namespaces, { key: [LIVE, "board"], path: "/board" });
      break;
    case "health": {
      out.push(trends, { key: ["maintenance"], path: "/maintenance" });
      const tab = p.get("tab");
      if (tab === "resources") out.push({ key: ["resources"], path: "/resources" });
      if (!tab || tab === "problems") out.push(figures("problems"));
      if (tab === "backups") out.push(figures("backups"));
      break;
    }
    case "sites": {
      if (!site) {
        if (p.get("tab") === "deploys") out.push(trends);
        break;
      }
      out.push(trends);
      const tab = p.get("tab");
      if (tab === "sync") out.push({ key: ["convergence"], path: "/convergence" });
      if (tab === "setup")
        out.push(
          { key: ["convergence"], path: "/convergence" },
          { key: ["resources"], path: "/resources" },
        );
      const ns = qs({ namespace: site });
      if (tab === "deploys")
        out.push({ key: ["workers-builds", site], path: `/workers-builds${ns}` });
      if (tab === "traffic") {
        out.push(
          { key: ["site-search", site], path: `/site-search${ns}` },
          { key: ["site-traffic", site], path: `/site-traffic${ns}` },
        );
        if (site === "capsid") out.push({ key: ["not-found"], path: "/not-found" });
      }
      break;
    }
    case "projects":
      out.push(namespaces);
      break;
    case "prs":
      break;
    case "agents": {
      const tab = p.get("tab");
      if (!tab || tab === "roster") out.push(figures("roster"));
      if (tab === "activity") {
        const namespace = p.get("namespace") ?? "";
        const actor = p.get("actor") ?? "";
        out.push(
          figures("agents"),
          {
            key: ["activity", namespace, actor],
            path: `/activity${qs({ namespace, actor })}`,
          },
          trends,
        );
      }
      break;
    }
    case "packages":
      out.push(
        { key: ["shared-code"], path: "/shared-code" },
        { key: ["completeness"], path: "/completeness" },
      );
      if (demo)
        for (const pkg of feed?.live.packages ?? [])
          out.push({
            key: ["packages", "history", pkg.name],
            path: `/packages/history${qs({ name: pkg.name })}`,
          });
      break;
    case "memory": {
      const q = p.get("q")?.trim() || "";
      const doc = parseDocParam(p.get("doc"));
      const args: Record<string, string> = doc ? { ns: doc.ns, path: doc.path } : q ? { q } : {};
      out.push({
        key: ["library", doc?.ns ?? null, doc?.path ?? null, q],
        path: `/library${qs(args)}`,
      });
      const tab = p.get("tab");
      if (!doc && !q && (!tab || tab === "handoffs")) out.push(figures("memory"));
      break;
    }
    case "settings":
      out.push({ key: PUSH_KEY, path: "/push" });
      break;
  }
  if (drawer?.type === "audit")
    out.push({ key: ["activity", "row", drawer.id], path: `/activity${qs({ id: drawer.id })}` });
  return out;
}

async function readInto(client: QueryClient, server: PortalServer, spec: Spec): Promise<void> {
  // prefetchQuery never throws: a failed read is left out and the view reads it in the browser.
  await client.prefetchQuery({
    queryKey: spec.key,
    queryFn: async () =>
      ask<unknown>(async (): Promise<Answer<unknown>> =>
        answerOf(await server.read(spec.path), true),
      ),
  });
}

const feeds = new WeakMap<object, Promise<OpsFeed | null>>();
function feedOf(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<OpsFeed | null> {
  let feed = feeds.get(context);
  if (!feed) {
    feed = (async () => {
      const client = new QueryClient();
      await readInto(client, serverFor(context, request), { key: FEED_KEY, path: "/ops" });
      return (client.getQueryData(FEED_KEY) as OpsFeed | undefined) ?? null;
    })();
    feeds.set(context, feed);
  }
  return feed;
}

export async function prefetchFeed(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<DehydratedState> {
  const client = new QueryClient();
  const feed = await feedOf(context, request);
  if (feed) client.setQueryData(FEED_KEY, feed);
  return dehydrate(client);
}

export async function prefetchView(
  context: Readonly<RouterContextProvider>,
  request: Request,
  view: ViewId,
  drawer: { type: string; id: string } | null = null,
  site: string | null = null,
): Promise<DehydratedState> {
  const server = serverFor(context, request);
  const url = new URL(request.url);
  const client = new QueryClient();
  const demo = pageBase(url.pathname) !== "";
  const feed = await feedOf(context, request);
  await Promise.all(
    specsFor(view, url, feed, demo, drawer, site).map((s) => readInto(client, server, s)),
  );
  return dehydrate(client);
}
