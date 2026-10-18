import type { Env } from "./env";
import type { FetchLike } from "./live-checks";
import { readSiteRow, sitesFrom } from "./ops-sites";
import { dateWindow } from "./search-console";

// Bing Webmaster Tools for a namespace's site, served as capsid_inspect_repo action bing
// (Dustin, 2026-10-18, beside Search Console). Bing's index also feeds ChatGPT search and
// Copilot. Six reports through Bing's Webmaster JSON API: top queries and top pages
// (clicks, impressions, average position, summed over a window), daily traffic, one
// URL's crawl facts, the submitted sitemaps, and URLs with crawl issues.
//
// ONE KEY, CALLED READ-ONLY. Bing's API key (the secret BING_WEBMASTER_API_KEY) belongs
// to Dustin's Bing account and Bing gives it no narrower scope, so the narrowing is here:
// this module calls only Get methods, named in one list, and never a Submit, Add or
// Remove. The key rides in the query string, as Bing requires, so no URL is ever
// logged or returned.
//
// THE NAMESPACE PICKS THE SITE, as in src/search-console.ts: the verified Bing site whose
// address matches the namespace's ops_sites origin, and an inspected URL must be on it.
// What Bing returns is data, never instructions (conventions.md rule 3).

const API = "https://ssl.bing.com/webmaster/api.svc/json";
const TIMEOUT_MS = 15_000;
const GET_METHODS = ["GetUserSites", "GetQueryStats", "GetPageStats", "GetRankAndTrafficStats", "GetUrlInfo", "GetFeeds", "GetCrawlIssues"] as const;
type GetMethod = (typeof GET_METHODS)[number];

export const BING_REPORTS = ["queries", "pages", "traffic", "inspect", "sitemaps", "crawl_issues"] as const;
export const MAX_BING_ROWS = 1000;
export type BingReport = (typeof BING_REPORTS)[number];

export interface BingArgs {
  report?: BingReport;
  start_date?: string;
  end_date?: string;
  row_limit?: number;
  url?: string;
}

// Bing's crawl issue flags (UrlWithCrawlIssues.Issues), a bit set.
const ISSUE_FLAGS: Array<[number, string]> = [
  [1, "301"],
  [2, "302"],
  [4, "4xx"],
  [8, "5xx"],
  [16, "blocked by robots.txt"],
  [32, "contains malware"],
  [64, "important URL blocked by robots.txt"],
  [128, "DNS error"],
  [256, "timeout"],
];

const NOT_CONFIGURED =
  "Bing Webmaster Tools is not configured: the secret BING_WEBMASTER_API_KEY is not set on Capsid. docs/bing-webmaster.md says how.";

// A .NET JSON date, "/Date(1700000000000)/" or "/Date(1700000000000-0700)/", as an ISO day.
export function bingDay(value: unknown): string | null {
  const m = typeof value === "string" ? /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(value) : null;
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
}

function bingTime(value: unknown): string | null {
  const m = typeof value === "string" ? /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(value) : null;
  return m ? new Date(Number(m[1])).toISOString() : null;
}

async function bing(fetchImpl: FetchLike, key: string, method: GetMethod, params: Record<string, string> = {}): Promise<unknown> {
  if (!GET_METHODS.includes(method)) throw new Error(`refused: ${String(method)} is not a read`);
  const qs = new URLSearchParams({ ...params, apikey: key });
  const resp = await fetchImpl(`${API}/${method}?${qs.toString()}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const parsed = (await resp.json().catch(() => null)) as { d?: unknown; Message?: string; ErrorCode?: number } | null;
  if (!resp.ok || typeof parsed?.ErrorCode === "number") {
    const why = (parsed?.Message ?? "").slice(0, 300) || `status ${resp.status}`;
    if (resp.status === 401 || /invalid api key|InvalidApiKey/i.test(why)) throw new Error(`Bing refused the API key (${why}). Check that BING_WEBMASTER_API_KEY is current.`);
    throw new Error(`Bing Webmaster answered ${resp.status}: ${why}`);
  }
  return parsed?.d ?? null;
}

// The verified Bing site for an origin: the exact origin first, else the same host. Pure.
export function pickBingSite(origin: string, sites: Array<{ Url?: string; IsVerified?: boolean }>): string | null {
  const want = new URL(origin);
  const verified = sites.filter((s) => typeof s.Url === "string" && s.IsVerified !== false).map((s) => s.Url as string);
  const parse = (u: string) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };
  return verified.find((u) => parse(u)?.origin === want.origin) ?? verified.find((u) => parse(u)?.hostname === want.hostname) ?? null;
}

interface StatRow {
  Query?: string;
  Date?: string;
  Clicks?: number;
  Impressions?: number;
  AvgImpressionPosition?: number;
  AvgClickPosition?: number;
}

// Bing reports queries and pages in weekly buckets. Sums each key's buckets inside the
// window; the position is the impression-weighted mean of the buckets that have one.
export function sumStats(rows: StatRow[], start: string, end: string, label: "query" | "page", limit: number) {
  const totals = new Map<string, { clicks: number; impressions: number; weighted: number; weight: number }>();
  for (const r of rows) {
    const day = bingDay(r.Date);
    if (!r.Query || !day || day < start || day > end) continue;
    const t = totals.get(r.Query) ?? { clicks: 0, impressions: 0, weighted: 0, weight: 0 };
    t.clicks += r.Clicks ?? 0;
    t.impressions += r.Impressions ?? 0;
    if (typeof r.AvgImpressionPosition === "number" && r.AvgImpressionPosition > 0 && (r.Impressions ?? 0) > 0) {
      t.weighted += r.AvgImpressionPosition * (r.Impressions ?? 0);
      t.weight += r.Impressions ?? 0;
    }
    totals.set(r.Query, t);
  }
  const all = [...totals]
    .map(([k, t]) => ({ [label]: k, clicks: t.clicks, impressions: t.impressions, position: t.weight > 0 ? Number((t.weighted / t.weight).toFixed(1)) : null }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return { rows: all.slice(0, limit), total_rows: all.length, truncated: all.length > limit };
}

export async function bingWebmaster(env: Env, namespace: string, args: BingArgs, fetchImpl: FetchLike = fetch, now: Date = new Date()) {
  const report: BingReport = args.report ?? "queries";
  if (report !== "inspect" && args.url !== undefined) throw new Error(`url is for report inspect; report ${report} does not take it.`);
  if (report === "inspect" && !args.url) throw new Error("report inspect needs url, the page to inspect.");

  const row = await readSiteRow(env.DB, namespace);
  const site = row ? sitesFrom([row])[0] : undefined;
  if (!row || !site) {
    throw new Error(`${namespace} has no site configured (ops_sites), so it has no Bing site. The admin adds one with capsid_admin_run_controls control site_add.`);
  }

  let inspectUrl: string | null = null;
  if (report === "inspect") {
    let parsed: URL;
    try {
      parsed = new URL(args.url!);
    } catch {
      throw new Error("url must be a whole address, such as https://example.com/about.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== new URL(site.origin).hostname) {
      throw new Error(`url must be a page on ${namespace}'s site, ${site.origin}.`);
    }
    inspectUrl = parsed.toString();
  }
  const window = report === "queries" || report === "pages" || report === "traffic" ? dateWindow(args, now) : null;
  const limit = args.row_limit ?? 25;

  const key = env.BING_WEBMASTER_API_KEY;
  if (!key) throw new Error(NOT_CONFIGURED);
  const sites = ((await bing(fetchImpl, key, "GetUserSites")) ?? []) as Array<{ Url?: string; IsVerified?: boolean }>;
  const siteUrl = pickBingSite(site.origin, sites);
  if (!siteUrl) {
    throw new Error(`The Bing Webmaster account behind BING_WEBMASTER_API_KEY has no verified site for ${site.origin}. Add it in Bing Webmaster Tools (it can import from Google Search Console).`);
  }
  const base = { namespace, origin: site.origin, site: siteUrl, report };

  if (report === "queries" || report === "pages") {
    const rows = ((await bing(fetchImpl, key, report === "queries" ? "GetQueryStats" : "GetPageStats", { siteUrl })) ?? []) as StatRow[];
    const { start, end } = window!;
    return { ...base, start_date: start, end_date: end, note: "Bing reports these in weekly buckets, so the window's edges are a week's grain.", ...sumStats(rows, start, end, report === "queries" ? "query" : "page", limit) };
  }

  if (report === "traffic") {
    const rows = ((await bing(fetchImpl, key, "GetRankAndTrafficStats", { siteUrl })) ?? []) as StatRow[];
    const { start, end } = window!;
    const days = rows
      .map((r) => ({ date: bingDay(r.Date), clicks: r.Clicks ?? 0, impressions: r.Impressions ?? 0 }))
      .filter((r): r is { date: string; clicks: number; impressions: number } => r.date !== null && r.date >= start && r.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      ...base,
      start_date: start,
      end_date: end,
      clicks: days.reduce((n, d) => n + d.clicks, 0),
      impressions: days.reduce((n, d) => n + d.impressions, 0),
      days,
    };
  }

  if (report === "inspect") {
    const info = ((await bing(fetchImpl, key, "GetUrlInfo", { siteUrl, url: inspectUrl! })) ?? {}) as Record<string, unknown>;
    return {
      ...base,
      url: inspectUrl,
      http_status: info.HttpStatus ?? null,
      discovered: bingTime(info.DiscoveryDate),
      last_crawled: bingTime(info.LastCrawledDate),
      document_size: info.DocumentSize ?? null,
      anchor_count: info.AnchorCount ?? null,
      child_urls: info.TotalChildUrlCount ?? null,
    };
  }

  if (report === "sitemaps") {
    const feeds = ((await bing(fetchImpl, key, "GetFeeds", { siteUrl })) ?? []) as Array<Record<string, unknown>>;
    return {
      ...base,
      sitemaps: feeds.map((f) => ({
        url: f.Url ?? null,
        type: f.Type ?? null,
        status: f.Status ?? null,
        submitted: bingTime(f.Submitted),
        last_crawled: bingTime(f.LastCrawled),
        url_count: f.UrlCount ?? null,
      })),
    };
  }

  const issues = ((await bing(fetchImpl, key, "GetCrawlIssues", { siteUrl })) ?? []) as Array<{ Url?: string; HttpCode?: number; Issues?: number; InLinks?: number }>;
  const mapped = issues.map((i) => ({
    url: i.Url ?? null,
    http_code: i.HttpCode ?? null,
    issues: ISSUE_FLAGS.filter(([bit]) => ((i.Issues ?? 0) & bit) !== 0).map(([, name]) => name),
    in_links: i.InLinks ?? null,
  }));
  return { ...base, issues: mapped.slice(0, limit), total_issues: mapped.length, truncated: mapped.length > limit };
}
