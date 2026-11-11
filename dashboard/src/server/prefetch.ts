import { QueryClient, dehydrate, type DehydratedState } from "@tanstack/react-query";
import { createContext, type RouterContextProvider } from "react-router";
import { answerOf, ask, type Answer } from "capsomer/react/data";
import { FEED_KEY, LIVE } from "../lib/api";
import { DAY } from "../lib/format";
import { pageBase } from "../lib/router";
import type { OpsFeed } from "../types";
import type { ViewId } from "../app/ctx";
import { digestSince } from "../views/Overnight";
import { FILTER_KEYS, PUSH_KEY, parseDocParam } from "../lib/keys";

// The server's half of TanStack Query's server rendering (Advanced Server Rendering guide): a
// new QueryClient per request, the page's reads made before it renders, and the cache handed
// to the browser (dehydrate, then HydrationBoundary in the route), so the HTML carries every
// table, chart and number and the browser does not read them again to draw the page. After
// that the browser owns the data: the minute poll, Refresh and every filter read as before.
//
// The keys here are the ones the views' useAnswer calls use, so a read made here is the
// one the view finds. A read that fails is left out, and the view reads it in the browser
// and says why, as it always has.

/** One Portal read, named from its API root: "/ops", "/claims?since=...". */
export type PortalRead = (path: string) => Promise<Response>;

export interface PortalServer {
  /** The Portal's reads for this request: the Worker's own /portal/api routes with the
   *  visitor's session, or the demo's sample answers (src/portal-render.ts in the Worker). */
  read: PortalRead;
  /** This response's Content-Security-Policy nonce, for every script the page renders. */
  nonce: string;
}

// With no Worker in front (the dev server), reads go to the dev mock on the same origin, with the
// page's cookies. One key for the whole process, kept on globalThis: src/worker.ts sets it and the
// server build reads it, and each carries its own copy of this module.
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

/** What a view reads as it first draws, for the address it was opened at. */
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
  const generated = feed ? Date.parse(feed.live.generated) : Date.now();
  const out: Spec[] = [];
  switch (view) {
    case "needs":
      out.push(namespaces, trends, {
        key: ["claims", "waits"],
        path: `/claims${qs({ since: new Date(generated - 14 * DAY).toISOString() })}`,
      });
      out.push({
        key: [LIVE, "digest", digestSince(generated)],
        path: `/digest${qs({ since: digestSince(generated) })}`,
      });
      break;
    case "health":
      out.push(trends, { key: ["maintenance"], path: "/maintenance" });
      if (p.get("tab") === "resources") out.push({ key: ["resources"], path: "/resources" });
      break;
    case "sites": {
      // A site's own page reads what its tab shows; the list reads the deploy measures on its
      // Deploys tab.
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
      out.push(trends, { key: [LIVE, "merge-units"], path: "/merge-units" });
      break;
    case "queue":
      if (p.get("tab") === "checks") {
        const filter = Object.fromEntries(FILTER_KEYS.map((k) => [k, p.get(k) ?? ""])) as Record<
          (typeof FILTER_KEYS)[number],
          string
        >;
        out.push(trends, {
          key: ["claims", FILTER_KEYS.map((k) => filter[k]).join("\u0000")],
          path: `/claims${qs(filter)}`,
        });
        const job = p.get("job") ?? "";
        if (job) out.push({ key: ["claims", "job", job], path: `/claims${qs({ job })}` });
        break;
      }
      out.push(
        trends,
        { key: [LIVE, "stale"], path: "/stale" },
        { key: [LIVE, "plan"], path: "/plan" },
      );
      break;
    case "activity": {
      const namespace = p.get("namespace") ?? "";
      const actor = p.get("actor") ?? "";
      out.push({
        key: ["activity", namespace, actor],
        path: `/activity${qs({ namespace, actor })}`,
      });
      break;
    }
    case "agents":
      out.push(trends);
      break;
    case "packages":
      out.push(
        { key: ["shared-code"], path: "/shared-code" },
        { key: ["completeness"], path: "/completeness" },
      );
      // The demo draws each package's download chart at once (views/Packages.tsx).
      if (demo)
        for (const pkg of feed?.live.packages ?? [])
          out.push({
            key: ["packages", "history", pkg.name],
            path: `/packages/history${qs({ name: pkg.name })}`,
          });
      break;
    case "library": {
      const q = p.get("q")?.trim() || "";
      const doc = parseDocParam(p.get("doc"));
      const args: Record<string, string> = doc ? { ns: doc.ns, path: doc.path } : q ? { q } : {};
      out.push({
        key: ["library", doc?.ns ?? null, doc?.path ?? null, q],
        path: `/library${qs(args)}`,
      });
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
  // A read that fails is not kept (prefetchQuery never throws): the view reads it again in the
  // browser and says why.
  await client.prefetchQuery({
    queryKey: spec.key,
    queryFn: async () =>
      ask<unknown>(async (): Promise<Answer<unknown>> =>
        answerOf(await server.read(spec.path), true),
      ),
  });
}

// The feed, read once per page: the shell renders it, and a view's reads are timed from it, as
// the view times them in the browser (the first render's now is the feed's read time).
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

/** The feed, for the shell: the letterhead, the menu's counts and every view read it. */
export async function prefetchFeed(
  context: Readonly<RouterContextProvider>,
  request: Request,
): Promise<DehydratedState> {
  const client = new QueryClient();
  const feed = await feedOf(context, request);
  if (feed) client.setQueryData(FEED_KEY, feed);
  return dehydrate(client);
}

/** A view's own reads, for the address it was opened at. */
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
