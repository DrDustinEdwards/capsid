import { bingWebmaster } from "./bing-webmaster";
import type { Env } from "./env";
import { jsonResponse, textResponse } from "./http";
import { namespaceNameRefusal } from "./namespace-admin";
import { cloudflareCredentials, type FetchLike } from "./ops-cloudflare";
import { OPS_RETURN_TO } from "./ops-feed";
import { readSiteRow, sitesFrom } from "./ops-sites";
import type {
  BingSearchData,
  GoogleSearchData,
  PortalBuildLog,
  PortalSiteSearch,
  PortalSiteTraffic,
  PortalWorkersBuilds,
  SearchRow,
  SiteNoData,
  SiteSource,
  TrafficAiCrawlers,
  TrafficNotFound,
  TrafficServerErrors,
  TrafficWebVitals,
  WorkersBuild,
} from "./ops-types/views";
import { portalGate } from "./portal-auth";
import { searchConsole } from "./search-console";
import { MAX_TRAFFIC_DAYS, siteTraffic } from "./site-traffic";
import { BUILDS_DEFAULT, BUILDS_MAX, buildLogs, listBuilds } from "./workers-builds";

// One site's own page in the Portal: its Search and traffic tab and its Deploys tab, read
// live for one namespace. Four routes, each a door onto a library the chat tools already
// serve, so the Portal and chat cannot disagree:
//   GET /portal/api/site-search?namespace=    searchConsole and bingWebmaster
//                                             (capsid_inspect_repo actions search_console and bing_webmaster)
//   GET /portal/api/site-traffic?namespace=&days=   siteTraffic, every TRAFFIC_REPORTS report
//                                             (capsid_inspect_repo action site_traffic)
//   GET /portal/api/workers-builds?namespace=&limit=   listBuilds
//   GET /portal/api/build-log?build=          buildLogs (capsid_admin_read_ops actions workers_builds and workers_build_logs)
// The site, its property and its Worker come from the namespace's ops_sites row, never from
// the caller. Each source answers on its own: data, or no data with the reason (docs/portal.md,
// "No data is a state, never a zero"), so one source failing leaves the others. They read the
// outside services and write nothing. Routes, not tools, so no grant is checked here (one
// enforcement point, test/route-gates.test.ts): each answers to portalGate, and src/scope.ts
// lists it among the routes gated some other way. Tests: test-integration/portal-site.test.ts.

export const PORTAL_SITE_SEARCH_PATH = "/portal/api/site-search";
export const PORTAL_SITE_TRAFFIC_PATH = "/portal/api/site-traffic";
export const PORTAL_WORKERS_BUILDS_PATH = "/portal/api/workers-builds";
export const PORTAL_BUILD_LOG_PATH = "/portal/api/build-log";

const BUILD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_TRAFFIC_DAYS = 7;

const none = (
  kind: SiteNoData,
  reason: string,
): { ok: false; kind: SiteNoData; reason: string } => ({ ok: false, kind, reason });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A source's read: its data, or the read's own error as the reason. */
async function attempt<T>(read: () => Promise<SiteSource<T>>): Promise<SiteSource<T>> {
  try {
    return await read();
  } catch (err) {
    return none("error", message(err));
  }
}

/** A whole number from 1 to max in the query, or the default when absent; null when bad. */
function wholeParam(url: URL, name: string, max: number, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^[0-9]{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

/** The namespace the query names, or the 400 that says why not. */
function namespaceParam(
  url: URL,
): { ok: true; namespace: string } | { ok: false; response: Response } {
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const bad = namespaceNameRefusal(namespace);
  return bad || !namespace
    ? { ok: false, response: textResponse(bad ?? "namespace is required", 400) }
    : { ok: true, namespace };
}

/** The namespace's configured site (a row with an origin), or null. */
async function configuredSite(env: Env, namespace: string) {
  const row = await readSiteRow(env.DB, namespace);
  return row ? (sitesFrom([row])[0] ?? null) : null;
}

const noSite = (namespace: string, what: string) =>
  none(
    "no_site",
    `${namespace} has no site configured (ops_sites), so it has no ${what}. Add one in Settings (site_add).`,
  );

// ---------------------------------------------------------------------------
// Search: Google Search Console and Bing Webmaster.

interface PerformanceAnswer {
  origin: string;
  property: string;
  start_date: string;
  end_date: string;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

interface BingStatsAnswer {
  origin: string;
  site: string;
  start_date: string;
  end_date: string;
  note: string;
  rows: Array<Record<string, unknown>>;
  total_rows: number;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

function searchRow(r: Record<string, unknown>, key: "query" | "page"): SearchRow {
  const clicks = num(r.clicks);
  const impressions = num(r.impressions);
  // Bing gives no CTR; it is clicks over impressions, as Google computes it.
  const ctr =
    r.ctr !== undefined
      ? numOrNull(r.ctr)
      : impressions > 0
        ? Number((clicks / impressions).toFixed(4))
        : null;
  return {
    key: typeof r[key] === "string" ? (r[key] as string) : "",
    clicks,
    impressions,
    ctr,
    position: numOrNull(r.position),
  };
}

async function googleSource(
  env: Env,
  namespace: string,
  fetchImpl: FetchLike,
  now: Date,
): Promise<SiteSource<GoogleSearchData>> {
  if (!env.GSC_SERVICE_ACCOUNT_KEY) {
    return none(
      "not_configured",
      "Search Console is not configured: the secret GSC_SERVICE_ACCOUNT_KEY is not set on Capsid (docs/search-console.md).",
    );
  }
  return attempt(async () => {
    // The totals first, so the service account's token is fetched once for the three reads.
    const totals = (await searchConsole(
      env,
      namespace,
      { report: "performance", dimensions: [] },
      fetchImpl,
      now,
    )) as unknown as PerformanceAnswer;
    const [queries, pages] = (await Promise.all([
      searchConsole(
        env,
        namespace,
        { report: "performance", dimensions: ["query"] },
        fetchImpl,
        now,
      ),
      searchConsole(
        env,
        namespace,
        { report: "performance", dimensions: ["page"] },
        fetchImpl,
        now,
      ),
    ])) as unknown as [PerformanceAnswer, PerformanceAnswer];
    const total = totals.rows[0];
    if (!total)
      return none(
        "empty",
        `Search Console has no data for ${totals.property} from ${totals.start_date} to ${totals.end_date}.`,
      );
    return {
      ok: true,
      data: {
        origin: totals.origin,
        property: totals.property,
        start_date: totals.start_date,
        end_date: totals.end_date,
        totals: {
          clicks: num(total.clicks),
          impressions: num(total.impressions),
          ctr: numOrNull(total.ctr),
          position: numOrNull(total.position),
        },
        queries: queries.rows.map((r) => searchRow(r, "query")),
        pages: pages.rows.map((r) => searchRow(r, "page")),
        queries_truncated: queries.truncated,
        pages_truncated: pages.truncated,
      },
    };
  });
}

async function bingSource(
  env: Env,
  namespace: string,
  fetchImpl: FetchLike,
  now: Date,
): Promise<SiteSource<BingSearchData>> {
  if (!env.BING_WEBMASTER_API_KEY) {
    return none(
      "not_configured",
      "Bing Webmaster Tools is not configured: the secret BING_WEBMASTER_API_KEY is not set on Capsid (docs/bing-webmaster.md).",
    );
  }
  return attempt(async () => {
    const [traffic, queries, pages] = (await Promise.all([
      bingWebmaster(env, namespace, { report: "traffic" }, fetchImpl, now),
      bingWebmaster(env, namespace, { report: "queries" }, fetchImpl, now),
      bingWebmaster(env, namespace, { report: "pages" }, fetchImpl, now),
    ])) as unknown as [
      {
        origin: string;
        site: string;
        start_date: string;
        end_date: string;
        clicks: number;
        impressions: number;
        days: BingSearchData["days"];
      },
      BingStatsAnswer,
      BingStatsAnswer,
    ];
    if (traffic.days.length === 0 && queries.total_rows === 0 && pages.total_rows === 0) {
      return none(
        "empty",
        `Bing has no data for ${traffic.site} from ${traffic.start_date} to ${traffic.end_date}.`,
      );
    }
    return {
      ok: true,
      data: {
        origin: traffic.origin,
        site: traffic.site,
        start_date: traffic.start_date,
        end_date: traffic.end_date,
        totals: { clicks: traffic.clicks, impressions: traffic.impressions },
        days: traffic.days,
        queries: queries.rows.map((r) => searchRow(r, "query")),
        pages: pages.rows.map((r) => searchRow(r, "page")),
        queries_total: queries.total_rows,
        pages_total: pages.total_rows,
        note: queries.note,
      },
    };
  });
}

/** The search tab's read: both sources at once, each its data or its reason. */
export async function readSiteSearch(
  env: Env,
  namespace: string,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<PortalSiteSearch> {
  const generated = now.toISOString();
  if (!(await configuredSite(env, namespace))) {
    const reason = noSite(namespace, "search data");
    return { generated, namespace, google: reason, bing: reason };
  }
  const [google, bing] = await Promise.all([
    googleSource(env, namespace, fetchImpl, now),
    bingSource(env, namespace, fetchImpl, now),
  ]);
  return { generated, namespace, google, bing };
}

// ---------------------------------------------------------------------------
// Traffic: what Cloudflare's edge saw.

/** The traffic tab's read: the four reports at once over the last `days`. */
export async function readSiteTraffic(
  env: Env,
  namespace: string,
  days: number,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<PortalSiteTraffic> {
  const base = { generated: now.toISOString(), namespace, days };
  const site = await configuredSite(env, namespace);
  const creds = cloudflareCredentials(env);
  const unavailable = !site
    ? noSite(namespace, "traffic report")
    : !creds.ok
      ? none(
          "not_configured",
          `The traffic report reads Cloudflare with the watcher's token, and ${creds.reason}.`,
        )
      : new URL(site.origin).hostname.endsWith(".workers.dev")
        ? none(
            "not_configured",
            `${site.origin} is a workers.dev host, which Cloudflare's HTTP request record does not include.`,
          )
        : null;
  if (unavailable)
    return {
      ...base,
      not_found: unavailable,
      server_errors: unavailable,
      web_vitals: unavailable,
      ai_crawlers: unavailable,
    };

  const read = <T>(report: "not_found" | "server_errors" | "web_vitals" | "ai_crawlers") =>
    attempt<T>(async () => ({
      ok: true,
      data: (await siteTraffic(env, namespace, { report, days }, fetchImpl, now)) as unknown as T,
    }));
  const [notFound, serverErrors, vitals, crawlers] = await Promise.all([
    read<TrafficNotFound>("not_found"),
    read<TrafficServerErrors>("server_errors"),
    read<TrafficWebVitals>("web_vitals"),
    read<TrafficAiCrawlers>("ai_crawlers"),
  ]);
  // No page view measured is no data, never a vital of zero.
  const webVitals: SiteSource<TrafficWebVitals> =
    vitals.ok && vitals.data.page_views_measured === 0
      ? none(
          "empty",
          `No visitor's browser reported web vitals for ${site!.origin} in the last ${days} day${days === 1 ? "" : "s"}.`,
        )
      : vitals;
  return {
    ...base,
    not_found: notFound.ok
      ? {
          ok: true,
          data: pick(notFound.data, [
            "since",
            "note",
            "paths",
            "total_paths",
            "probes",
            "truncated",
          ]),
        }
      : notFound,
    server_errors: serverErrors.ok
      ? {
          ok: true,
          data: pick(serverErrors.data, ["since", "note", "failures", "hours", "truncated"]),
        }
      : serverErrors,
    web_vitals: webVitals.ok
      ? { ok: true, data: pick(webVitals.data, ["since", "page_views_measured", "unit", "vitals"]) }
      : webVitals,
    ai_crawlers: crawlers.ok
      ? { ok: true, data: pick(crawlers.data, ["since", "note", "crawlers", "truncated"]) }
      : crawlers,
  };
}

// Only the fields the contract names: the library's answer also repeats the namespace,
// origin and report, which the page already has.
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as Pick<T, K>;
}

// ---------------------------------------------------------------------------
// Workers Builds and one build's log.

/** The deploys tab's builds: the Worker its site row names, newest first. */
export async function readWorkersBuilds(
  env: Env,
  namespace: string,
  limit: number,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<PortalWorkersBuilds> {
  const generated = now.toISOString();
  const row = await readSiteRow(env.DB, namespace);
  const script = row?.script ?? null;
  if (!row) return { generated, namespace, script, builds: noSite(namespace, "Workers Builds") };
  if (!script) {
    return {
      generated,
      namespace,
      script,
      builds: none(
        "no_site",
        row.platform === "vercel"
          ? `${namespace} runs on Vercel, so it has no Workers Builds.`
          : `${namespace}'s site row names no Worker script, so its Workers Builds cannot be found. Add the script in Settings.`,
      ),
    };
  }
  const creds = cloudflareCredentials(env);
  if (!creds.ok)
    return {
      generated,
      namespace,
      script,
      builds: none("not_configured", `Workers Builds cannot be read: ${creds.reason}.`),
    };
  const builds = await attempt<{ builds: WorkersBuild[] }>(async () => {
    const read = await listBuilds(env, { script, limit }, fetchImpl, false);
    if (read.builds.length === 0) {
      return none(
        "empty",
        `Cloudflare has no Workers Builds for ${script}: it deploys some other way (CI running wrangler deploy), or has not built yet.`,
      );
    }
    return { ok: true, data: { builds: read.builds } };
  });
  return { generated, namespace, script, builds };
}

/** One build's log, its last lines. */
export async function readBuildLog(
  env: Env,
  buildUuid: string,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<PortalBuildLog> {
  const generated = now.toISOString();
  const creds = cloudflareCredentials(env);
  if (!creds.ok)
    return {
      generated,
      build_uuid: buildUuid,
      log: none("not_configured", `Workers Builds cannot be read: ${creds.reason}.`),
    };
  const log = await attempt<{
    lines: string[];
    line_count: number;
    truncated: boolean;
    note: string | null;
  }>(async () => {
    const read = await buildLogs(env, { build_uuid: buildUuid }, fetchImpl);
    if (read.line_count === 0) return none("empty", `The log of build ${buildUuid} has no lines.`);
    return {
      ok: true,
      data: {
        lines: read.lines,
        line_count: read.line_count,
        truncated: read.truncated,
        note: read.note ?? null,
      },
    };
  });
  return { generated, build_uuid: buildUuid, log };
}

// ---------------------------------------------------------------------------
// The routes.

/** GET /portal/api/site-search?namespace=. */
export async function handlePortalSiteSearch(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const ns = namespaceParam(new URL(request.url));
  if (!ns.ok) return ns.response;
  return jsonResponse(await readSiteSearch(env, ns.namespace, fetch, now));
}

/** A namespace read with one whole-number parameter (days, limit): the gate, the namespace
 *  and the number, each refused with its reason, then the read. */
async function countedRead(
  request: Request,
  env: Env,
  now: Date,
  param: { name: string; max: number; fallback: number },
  read: (namespace: string, n: number) => Promise<unknown>,
): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const url = new URL(request.url);
  const ns = namespaceParam(url);
  if (!ns.ok) return ns.response;
  const n = wholeParam(url, param.name, param.max, param.fallback);
  if (n === null)
    return textResponse(`${param.name} must be a whole number from 1 to ${param.max}.`, 400);
  return jsonResponse(await read(ns.namespace, n));
}

/** GET /portal/api/site-traffic?namespace=&days=. */
export function handlePortalSiteTraffic(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  return countedRead(
    request,
    env,
    now,
    { name: "days", max: MAX_TRAFFIC_DAYS, fallback: DEFAULT_TRAFFIC_DAYS },
    (ns, days) => readSiteTraffic(env, ns, days, fetch, now),
  );
}

/** GET /portal/api/workers-builds?namespace=&limit=. */
export function handlePortalWorkersBuilds(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  return countedRead(
    request,
    env,
    now,
    { name: "limit", max: BUILDS_MAX, fallback: BUILDS_DEFAULT },
    (ns, limit) => readWorkersBuilds(env, ns, limit, fetch, now),
  );
}

/** GET /portal/api/build-log?build=<uuid>. */
export async function handlePortalBuildLog(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const build = new URL(request.url).searchParams.get("build") ?? "";
  if (!BUILD_UUID.test(build))
    return textResponse(
      "build must be a build's id (a lowercase UUID), from GET /portal/api/workers-builds.",
      400,
    );
  return jsonResponse(await readBuildLog(env, build, fetch, now));
}
