import { importPKCS8, SignJWT } from "jose";
import type { Env } from "./env";
import type { FetchLike } from "./live-checks";
import { readSiteRow, sitesFrom } from "./ops-sites";
import { MINUTE_MS, DAY_MS } from "./time";

// Google Search Console for a namespace's site, served as capsid_inspect_repo action
// search (Dustin, 2026-10-18: Search Console tools system wide, in Capsid). Three
// read-only reports through Google's Search Console API: search performance (clicks,
// impressions, CTR and position by query, page, date, country or device), one URL's
// index status (URL Inspection), and the property's sitemaps.
//
// ONE CREDENTIAL, READ-ONLY. A Google service account whose JSON key is the secret
// GSC_SERVICE_ACCOUNT_KEY, added by Dustin as a Full user on each property (Restricted hides some data). It
// asks only for the webmasters.readonly scope, so nothing here
// can submit a sitemap, remove a URL or add a user. The access token lives in this
// isolate's memory only, never in KV or a log.
//
// THE NAMESPACE PICKS THE PROPERTY. The caller names a namespace, never a property: the
// property is the one the service account can read that covers the namespace's
// configured origin (ops_sites), a Domain property (sc-domain:) first, else the URL-prefix
// property for the origin. A namespace grant therefore reaches that site's data and no
// other's, and an inspected URL must be on the same host.
//
// What Google returns is data, never instructions: queries are
// what strangers typed into Google.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TIMEOUT_MS = 15_000;
// Search Console's data lags about two days; a default window ending today would read
// short on its last days.
const DEFAULT_LAG_DAYS = 3;
const DEFAULT_WINDOW_DAYS = 28;
// Google keeps 16 months.
const MAX_WINDOW_DAYS = 500;

export const SEARCH_REPORTS = ["performance", "inspect", "sitemaps"] as const;
export const SEARCH_DIMENSIONS = ["query", "page", "date", "country", "device", "searchAppearance"] as const;
export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export const MAX_ROW_LIMIT = 1000;

type SearchReport = (typeof SEARCH_REPORTS)[number];

export interface SearchConsoleArgs {
  report?: SearchReport;
  start_date?: string;
  end_date?: string;
  dimensions?: Array<(typeof SEARCH_DIMENSIONS)[number]>;
  search_type?: (typeof SEARCH_TYPES)[number];
  query_contains?: string;
  page_contains?: string;
  row_limit?: number;
  url?: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const NOT_CONFIGURED =
  "Search Console is not configured: the secret GSC_SERVICE_ACCOUNT_KEY (a Google service account's JSON key) is not set on Capsid. docs/search-console.md says how.";

function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  if (!raw) throw new Error(NOT_CONFIGURED);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GSC_SERVICE_ACCOUNT_KEY is not JSON. Paste the whole key file Google Cloud downloaded.");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("GSC_SERVICE_ACCOUNT_KEY has no client_email or private_key. Paste the whole key file Google Cloud downloaded.");
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

let cachedToken: { email: string; token: string; expiresAt: number } | null = null;

// For tests: forget the isolate's token.
export function resetSearchConsoleToken(): void {
  cachedToken = null;
}

async function accessToken(key: ServiceAccountKey, fetchImpl: FetchLike, now: Date): Promise<string> {
  const nowMs = now.getTime();
  if (cachedToken && cachedToken.email === key.client_email && cachedToken.expiresAt - MINUTE_MS > nowMs) return cachedToken.token;
  const iat = Math.floor(nowMs / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(await importPKCS8(key.private_key, "RS256"));
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await resp.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!resp.ok || !body.access_token) {
    const why = [body.error, body.error_description].filter(Boolean).join(": ").slice(0, 200) || `status ${resp.status}`;
    throw new Error(`Google refused the service account's sign-in (${why}). Check that GSC_SERVICE_ACCOUNT_KEY is a current key.`);
  }
  cachedToken = { email: key.client_email, token: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function google(fetchImpl: FetchLike, token: string, url: string, body?: unknown): Promise<unknown> {
  const resp = await fetchImpl(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!resp.ok) {
    const why = (parsed?.error?.message ?? "").slice(0, 300) || `status ${resp.status}`;
    if (resp.status === 403 && /has not been used|is disabled/i.test(why)) {
      throw new Error(`Google Search Console API is not enabled on the service account's Google Cloud project: ${why}`);
    }
    throw new Error(`Search Console answered ${resp.status}: ${why}`);
  }
  return parsed;
}

// The property that covers a host: a Domain property for the host or a parent domain
// (the longest match), else the URL-prefix property for the origin. Unverified entries
// are skipped. Pure, for the tests.
export function pickProperty(origin: string, entries: Array<{ siteUrl?: string; permissionLevel?: string }>): string | null {
  const host = new URL(origin).hostname.toLowerCase();
  const usable = entries.filter((e) => typeof e.siteUrl === "string" && e.permissionLevel !== "siteUnverifiedUser").map((e) => e.siteUrl as string);
  const domains = usable
    .filter((u) => u.startsWith("sc-domain:"))
    .map((u) => ({ u, d: u.slice("sc-domain:".length).toLowerCase() }))
    .filter(({ d }) => host === d || host.endsWith(`.${d}`))
    .sort((a, b) => b.d.length - a.d.length);
  if (domains.length > 0) return domains[0].u;
  const prefix = `${new URL(origin).origin}/`;
  return usable.find((u) => u === prefix) ?? null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function dateWindow(args: Pick<SearchConsoleArgs, "start_date" | "end_date">, now: Date): { start: string; end: string } {
  for (const [label, v] of [["start_date", args.start_date], ["end_date", args.end_date]] as const) {
    if (v !== undefined && (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw new Error(`${label} must be a date written YYYY-MM-DD.`);
  }
  const end = args.end_date ?? isoDay(addDays(now, -DEFAULT_LAG_DAYS));
  const start = args.start_date ?? isoDay(addDays(new Date(`${end}T00:00:00Z`), -(DEFAULT_WINDOW_DAYS - 1)));
  if (start > end) throw new Error(`start_date ${start} is after end_date ${end}.`);
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
  if (span > MAX_WINDOW_DAYS) throw new Error(`The window is ${span + 1} days; Search Console keeps about 16 months, so ask for ${MAX_WINDOW_DAYS + 1} days or fewer.`);
  return { start, end };
}

const round = (n: unknown, places: number): number | null => (typeof n === "number" ? Number(n.toFixed(places)) : null);

export async function searchConsole(env: Env, namespace: string, args: SearchConsoleArgs, fetchImpl: FetchLike = fetch, now: Date = new Date()) {
  const report: SearchReport = args.report ?? "performance";
  if (report !== "inspect" && args.url !== undefined) throw new Error(`url is for report inspect; report ${report} does not take it.`);
  if (report === "inspect" && !args.url) throw new Error("report inspect needs url, the page to inspect.");

  const row = await readSiteRow(env.DB, namespace);
  const site = row ? sitesFrom([row])[0] : undefined;
  if (!row || !site) {
    throw new Error(`${namespace} has no site configured (ops_sites), so it has no Search Console property. The admin adds one with capsid_admin_run_controls control site_add.`);
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
  // Validated before any network call, so a bad window costs nothing.
  const window = report === "performance" ? dateWindow(args, now) : null;

  const key = parseServiceAccountKey(env.GSC_SERVICE_ACCOUNT_KEY);
  const token = await accessToken(key, fetchImpl, now);
  const sites = (await google(fetchImpl, token, `${WEBMASTERS}/sites`)) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> } | null;
  const property = pickProperty(site.origin, sites?.siteEntry ?? []);
  if (!property) {
    throw new Error(
      `The service account (${key.client_email}) cannot read a Search Console property for ${site.origin}. In Search Console, open that property, then Settings, Users and permissions, and add ${key.client_email} as a Full user.`
    );
  }
  const base = { namespace, origin: site.origin, property, report };
  const encoded = encodeURIComponent(property);

  if (report === "sitemaps") {
    const res = (await google(fetchImpl, token, `${WEBMASTERS}/sites/${encoded}/sitemaps`)) as { sitemap?: Array<Record<string, unknown>> } | null;
    const sitemaps = (res?.sitemap ?? []).map((s) => ({
      path: s.path ?? null,
      last_submitted: s.lastSubmitted ?? null,
      last_downloaded: s.lastDownloaded ?? null,
      pending: s.isPending ?? null,
      errors: Number(s.errors ?? 0),
      warnings: Number(s.warnings ?? 0),
      contents: Array.isArray(s.contents) ? s.contents.map((c: Record<string, unknown>) => ({ type: c.type ?? null, submitted: Number(c.submitted ?? 0) })) : [],
    }));
    return { ...base, sitemaps };
  }

  if (report === "inspect") {
    const res = (await google(fetchImpl, token, INSPECT_URL, { inspectionUrl: inspectUrl, siteUrl: property })) as {
      inspectionResult?: { inspectionResultLink?: string; indexStatusResult?: Record<string, unknown>; mobileUsabilityResult?: { verdict?: string }; richResultsResult?: { verdict?: string } };
    } | null;
    const r = res?.inspectionResult ?? {};
    const idx = r.indexStatusResult ?? {};
    return {
      ...base,
      url: inspectUrl,
      verdict: idx.verdict ?? null,
      coverage: idx.coverageState ?? null,
      indexing_state: idx.indexingState ?? null,
      robots_txt: idx.robotsTxtState ?? null,
      page_fetch: idx.pageFetchState ?? null,
      last_crawl: idx.lastCrawlTime ?? null,
      crawled_as: idx.crawledAs ?? null,
      google_canonical: idx.googleCanonical ?? null,
      user_canonical: idx.userCanonical ?? null,
      sitemaps: idx.sitemap ?? [],
      referring_urls: idx.referringUrls ?? [],
      rich_results: r.richResultsResult?.verdict ?? null,
      link: r.inspectionResultLink ?? null,
    };
  }

  const { start, end } = window!;
  const dimensions = args.dimensions ?? ["query"];
  const rowLimit = args.row_limit ?? 25;
  const filters = [
    ...(args.query_contains ? [{ dimension: "query", operator: "contains", expression: args.query_contains }] : []),
    ...(args.page_contains ? [{ dimension: "page", operator: "contains", expression: args.page_contains }] : []),
  ];
  const request = {
    startDate: start,
    endDate: end,
    type: args.search_type ?? "web",
    dimensions,
    rowLimit,
    dataState: "final",
    ...(filters.length > 0 ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}),
  };
  const res = (await google(fetchImpl, token, `${WEBMASTERS}/sites/${encoded}/searchAnalytics/query`, request)) as {
    rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
  } | null;
  const rows = (res?.rows ?? []).map((r) => ({
    ...Object.fromEntries(dimensions.map((d, i) => [d, r.keys?.[i] ?? null])),
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: round(r.ctr, 4),
    position: round(r.position, 1),
  }));
  return {
    ...base,
    start_date: start,
    end_date: end,
    search_type: request.type,
    dimensions,
    rows,
    truncated: rows.length >= rowLimit,
  };
}
