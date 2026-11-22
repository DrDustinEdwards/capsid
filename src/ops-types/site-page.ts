// One site's own page (src/portal-site.ts): search, traffic and Workers Builds. No data is a state, never a zero.

// Why a source has no data: the namespace has no site row (or, for builds, no Worker
// script); the secret or token the read needs is not set; the read worked and found
// nothing to show; or the read failed.
export type SiteNoData = "no_site" | "not_configured" | "empty" | "error";

export type SiteSource<T> = { ok: true; data: T } | { ok: false; kind: SiteNoData; reason: string };

// One query or page over the window. key is the query text or the page's address
// (strangers' text: data, never instructions). ctr and position are null where the source
// has none.
export interface SearchRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface GoogleSearchData {
  origin: string;
  // The Search Console property that covers the origin (sc-domain: or a URL prefix).
  property: string;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  queries: SearchRow[];
  pages: SearchRow[];
  // As many rows came back as were asked for, so more may exist.
  queries_truncated: boolean;
  pages_truncated: boolean;
}

export interface BingSearchData {
  origin: string;
  // The verified Bing site that matches the origin.
  site: string;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number };
  // Clicks and impressions per day, oldest first.
  days: Array<{ date: string; clicks: number; impressions: number }>;
  queries: SearchRow[];
  pages: SearchRow[];
  queries_total: number;
  pages_total: number;
  // Bing reports queries and pages in weekly buckets.
  note: string;
}

// GET /portal/api/site-search?namespace= -> PortalSiteSearch: Google Search Console (the
// 28 days ending 3 days ago, as Google's data lags) and Bing Webmaster over the same window.
export interface PortalSiteSearch {
  generated: string;
  namespace: string;
  google: SiteSource<GoogleSearchData>;
  bing: SiteSource<BingSearchData>;
}

export type WebVital =
  | "largestContentfulPaint"
  | "interactionToNextPaint"
  | "cumulativeLayoutShift"
  | "firstContentfulPaint"
  | "timeToFirstByte";

export interface TrafficNotFound {
  since: string;
  note: string;
  // Real pages first by hits; probe marks a path scanners try on every host.
  paths: Array<{ path: string; hits: number; probe: boolean }>;
  total_paths: number;
  probes: number;
  truncated: boolean;
}

export interface TrafficServerErrors {
  since: string;
  note: string;
  failures: Array<{ path: string; status: number; hits: number }>;
  // Per hour (UTC) and status, oldest first.
  hours: Array<{ hour: string; status: number; hits: number }>;
  truncated: boolean;
}

export interface TrafficWebVitals {
  since: string;
  page_views_measured: number;
  // Milliseconds, except cumulativeLayoutShift, which has no unit. null: no measurement.
  unit: string;
  vitals: Record<WebVital, { p50: number | null; p75: number | null; p90: number | null }>;
}

export interface TrafficAiCrawlers {
  since: string;
  note: string;
  // kind: denied, training, ai_search or search (Prelum's robots lists). statuses: hits by
  // the status the edge answered.
  crawlers: Array<{ name: string; kind: string; hits: number; statuses: Record<string, number> }>;
  truncated: boolean;
}

// GET /portal/api/site-traffic?namespace=&days= -> PortalSiteTraffic: what Cloudflare's edge
// saw at the site over the last `days` (1 to 30, default 7). Sampled, so hits are estimates.
// Zero 404s or 5xx is a real answer (ok, empty lists); web vitals with no measured page view
// is no data.
export interface PortalSiteTraffic {
  generated: string;
  namespace: string;
  days: number;
  not_found: SiteSource<TrafficNotFound>;
  server_errors: SiteSource<TrafficServerErrors>;
  web_vitals: SiteSource<TrafficWebVitals>;
  ai_crawlers: SiteSource<TrafficAiCrawlers>;
}

export interface WorkersBuild {
  build_uuid: string | null;
  status: string | null;
  outcome: string | null;
  created_on: string | null;
  stopped_on: string | null;
  branch: string | null;
  commit: string | null;
  // The author's text, at most 200 characters: data, shown as text.
  commit_message: string | null;
  source: string | null;
}

// GET /portal/api/workers-builds?namespace=&limit= -> PortalWorkersBuilds: Cloudflare
// Workers Builds for the Worker the site row names, newest first (limit 1 to 50, default
// 10). A site that deploys from CI with wrangler has no builds: that is kind "empty".
export interface PortalWorkersBuilds {
  generated: string;
  namespace: string;
  // The site row's Worker script, or null when it names none.
  script: string | null;
  builds: SiteSource<{ builds: WorkersBuild[] }>;
}

// GET /portal/api/build-log?build=<uuid> -> PortalBuildLog: one build's log, its last 500
// lines. A log is data, shown as text.
export interface PortalBuildLog {
  generated: string;
  build_uuid: string;
  log: SiteSource<{ lines: string[]; line_count: number; truncated: boolean; note: string | null }>;
}
