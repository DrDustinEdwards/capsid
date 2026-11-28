import { bingWebmaster } from "./bing-webmaster";
import type { FetchLike } from "./http";
import type { Env } from "./env";
import { jsonResponse, textResponse } from "@dustinedwards/site-runtime/http";
import { namespaceNameRefusal } from "./namespace-admin";
import { cloudflareCredentials } from "./ops-cloudflare";
import { readSiteRow, sitesFrom } from "./ops-sites";
import type {
  BingSearchData,
  GoogleSearchData,
  PortalSiteSearch,
  PortalSiteTraffic,
  SearchRow,
  SiteNoData,
  SiteSource,
  TrafficAiCrawlers,
  TrafficNotFound,
  TrafficServerErrors,
  TrafficWebVitals,
} from "./ops-types/site-page";
import { behindGate } from "./portal-auth";
import { searchConsole } from "./search-console";
import { MAX_TRAFFIC_DAYS, siteTraffic } from "./site-traffic";

import { errorMessage } from "@dustinedwards/site-runtime/log";
import { plural } from "@drdustinedwards/site-helpers/text";
// One site's own page in the Portal: its Search and traffic tab and its Deploys tab, read live for
// one namespace. Four routes, each a door onto a library the chat tools already serve, so the
// Portal and chat cannot disagree:

export const PORTAL_SITE_SEARCH_PATH = "/portal/api/site-search";
export const PORTAL_SITE_TRAFFIC_PATH = "/portal/api/site-traffic";

const DEFAULT_TRAFFIC_DAYS = 7;

export const none = (
  kind: SiteNoData,
  reason: string,
): { ok: false; kind: SiteNoData; reason: string } => ({ ok: false, kind, reason });
const message = (err: unknown): string => errorMessage(err);

/** A source's read: its data, or the read's own error as the reason. */
export async function attempt<T>(read: () => Promise<SiteSource<T>>): Promise<SiteSource<T>> {
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

export const noSite = (namespace: string, what: string) =>
  none(
    "no_site",
    `${namespace} has no site configured (ops_sites), so it has no ${what}. Add one in Settings (site_add).`,
  );

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
          `No visitor's browser reported web vitals for ${site!.origin} in the last ${plural(days, "day")}.`,
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

// The routes.

/** GET /portal/api/site-search?namespace=. */
export const handlePortalSiteSearch = behindGate(async (request, env, now) => {
  const ns = namespaceParam(new URL(request.url));
  if (!ns.ok) return ns.response;
  return jsonResponse(await readSiteSearch(env, ns.namespace, fetch, now));
});

// A namespace read with one whole-number parameter (days, limit): the gate, the namespace and the
// number, each refused with its reason, then the read.
export const countedRead = behindGate(
  async (
    request,
    _env,
    _now,
    _user,
    param: { name: string; max: number; fallback: number },
    read: (namespace: string, n: number) => Promise<unknown>,
  ) => {
    const url = new URL(request.url);
    const ns = namespaceParam(url);
    if (!ns.ok) return ns.response;
    const n = wholeParam(url, param.name, param.max, param.fallback);
    if (n === null)
      return textResponse(`${param.name} must be a whole number from 1 to ${param.max}.`, 400);
    return jsonResponse(await read(ns.namespace, n));
  },
);

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
