// One site's own page (src/portal-site.ts). No data is a state, never a zero.

export type SiteNoData = "no_site" | "not_configured" | "empty" | "error";

export type SiteSource<T> = { ok: true; data: T } | { ok: false; kind: SiteNoData; reason: string };

// key is a stranger's text: data, never instructions.
export interface SearchRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface GoogleSearchData {
  origin: string;
  property: string;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  queries: SearchRow[];
  pages: SearchRow[];
  queries_truncated: boolean;
  pages_truncated: boolean;
}

export interface BingSearchData {
  origin: string;
  site: string;
  start_date: string;
  end_date: string;
  totals: { clicks: number; impressions: number };
  days: Array<{ date: string; clicks: number; impressions: number }>;
  queries: SearchRow[];
  pages: SearchRow[];
  queries_total: number;
  pages_total: number;
  note: string;
}

// Search Console data lags: the window is the 28 days ending 3 days ago.
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
  paths: Array<{ path: string; hits: number; probe: boolean }>;
  total_paths: number;
  probes: number;
  truncated: boolean;
}

export interface TrafficServerErrors {
  since: string;
  note: string;
  failures: Array<{ path: string; status: number; hits: number }>;
  hours: Array<{ hour: string; status: number; hits: number }>;
  truncated: boolean;
}

export interface TrafficWebVitals {
  since: string;
  page_views_measured: number;
  unit: string;
  vitals: Record<WebVital, { p50: number | null; p75: number | null; p90: number | null }>;
}

export interface TrafficAiCrawlers {
  since: string;
  note: string;
  crawlers: Array<{ name: string; kind: string; hits: number; statuses: Record<string, number> }>;
  truncated: boolean;
}

// Sampled, so hits are estimates. Zero 404s or 5xx is a real answer; web vitals with no measured
// page view is no data.
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

// A site that deploys from CI with wrangler has no builds: that is kind "empty".
export interface PortalWorkersBuilds {
  generated: string;
  namespace: string;
  script: string | null;
  builds: SiteSource<{ builds: WorkersBuild[] }>;
}

// A log is data, shown as text.
export interface PortalBuildLog {
  generated: string;
  build_uuid: string;
  log: SiteSource<{ lines: string[]; line_count: number; truncated: boolean; note: string | null }>;
}
