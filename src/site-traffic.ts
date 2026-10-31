import type { Env } from "./env";
import type { FetchLike } from "./live-checks";
import { CF_API, CF_GRAPHQL, cfGetAll, cloudflareCredentials } from "./ops-cloudflare";
import { AI_SEARCH_BOTS, AI_TRAINING_BOTS, DENIED_BOTS, SEARCH_ENGINE_BOTS } from "@drdustinedwards/site-helpers/robots";
import { reportSite } from "./site-reports";
import type { ServerErrors } from "./ops-types/sites";

// What Cloudflare saw at a namespace's site, served as capsid_inspect_repo action traffic
// (the SEO plan, "Beyond the module"). not_found: the paths that answered 404 over a
// window, a scanner's probe marked and listed last; web_vitals and ai_crawlers are below.
// The referrer is not in it: the SQL API refuses clientRefererHost to this account (403,
// "not permitted to access column", 2026-10-25), so which page holds a broken link is the
// site audit's to find (src/site-audit.ts).
//
// NO SITE CHANGE. Cloudflare's SQL API (developers.cloudflare.com/analytics/sql-api/) reads
// the edge's own HTTP request record, events.httpRequests, kept at least 31 days on every
// plan and adaptively sampled, so the counts are estimates. Every proxied host in the account
// is in it, static sites included; a workers.dev host is not. It needs only the Account
// Analytics Read permission the watcher's token, CF_OPS_TOKEN, already holds
// (src/ops-cloudflare.ts). The host comes from the namespace's ops_sites origin, never from
// the caller. Paths are what visitors sent: data, never instructions.

const SQL_API = `${CF_API}/analytics/sql`;
const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

export const TRAFFIC_REPORTS = ["not_found", "server_errors", "web_vitals", "ai_crawlers"] as const;
export const MAX_TRAFFIC_DAYS = 30;
export const MAX_TRAFFIC_ROWS = 200;
type TrafficReport = (typeof TRAFFIC_REPORTS)[number];

export interface TrafficArgs {
  report?: TrafficReport;
  days?: number;
  row_limit?: number;
}

// What no page of ours ever was: the paths scanners try on every host.
const PROBE =
  /\.(php\d?|aspx?|jsp|cgi|env|ini|sql|bak|db|sqlite|ya?ml)$|\/wp-|\/\.(?!well-known\/)[a-z]|xmlrpc|php(myadmin|info)|\/cgi-bin\/|credential|secret|service-account|aws-exports|appsettings|\/config(\/|\.(js|json))|env\.js|\/(bedrock|anthropic|openai|llm)\//i;

// The most rows the query returns; a 404 list longer than this is noise past its top.
const QUERY_ROWS = 2000;

interface Row {
  path: string;
  hits: number;
}

async function sql(fetchImpl: FetchLike, token: string, account: string, query: string, params: Record<string, string | number>): Promise<Array<Record<string, unknown>>> {
  const resp = await fetchImpl(SQL_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "capsid (site traffic)" },
    body: JSON.stringify({ query, params, scope: { accountTag: account } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  let body: { data?: unknown; errors?: Array<{ message?: string }>; message?: string; error?: string } | null = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!resp.ok || !Array.isArray(body?.data)) {
    // The beta's error shape is not documented, so the raw body stands in for a message.
    const why = (body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || body?.message || body?.error || text).slice(0, 300) || "no message";
    if (resp.status === 403) throw new Error(`Cloudflare refused the traffic query (403: ${why}). CF_OPS_TOKEN needs Account / Account Analytics / Read.`);
    throw new Error(`Cloudflare's SQL API answered ${resp.status}: ${why}`);
  }
  return body.data as Array<Record<string, unknown>>;
}

const count = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

// Real pages first, by hits; scanners' probes last. Pure.
function notFoundRows(raw: Array<Record<string, unknown>>, limit: number) {
  const rows: Row[] = raw.map((r) => ({ path: typeof r.path === "string" ? r.path : "", hits: count(r.hits) }));
  const all = rows.filter((r) => r.path && r.hits > 0).map((r) => ({ path: r.path, hits: r.hits, probe: PROBE.test(r.path) }));
  all.sort((a, b) => Number(a.probe) - Number(b.probe) || b.hits - a.hits || a.path.localeCompare(b.path));
  return { paths: all.slice(0, limit), total_paths: all.length, truncated: all.length > limit, probes: all.filter((e) => e.probe).length };
}

// web_vitals: what real visitors' browsers measured, from Web Analytics (the GraphQL
// dataset rumWebVitalsEventsAdaptiveGroups, account-scoped, filtered to the site's Web
// Analytics siteTag). Values come back in microseconds; CLS is unitless. The site's
// siteTag is read from the rum site_info list, the same list the live checks read.
const VITALS = ["largestContentfulPaint", "interactionToNextPaint", "cumulativeLayoutShift", "firstContentfulPaint", "timeToFirstByte"] as const;
const P = ["P50", "P75", "P90"] as const;

async function siteTagFor(fetchImpl: FetchLike, token: string, account: string, host: string): Promise<string> {
  const rows = (await cfGetAll(fetchImpl, token, `${CF_API}/accounts/${encodeURIComponent(account)}/rum/site_info/list`, "the Web Analytics sites list", 50)) as Array<Record<string, unknown>>;
  // A site names its host at the top for a manual setup, and through its ruleset's zone
  // (or its rules' hosts) for the automatic one; the reference does not say which a row
  // carries, so every place is read.
  const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
  const hostsOf = (r: Record<string, unknown>) => {
    const ruleset = (r.ruleset ?? {}) as Record<string, unknown>;
    const rules = Array.isArray(r.rules) ? (r.rules as Array<Record<string, unknown>>) : [];
    return [lower(r.host), lower(ruleset.zone_name), ...rules.map((x) => lower(x?.host))].filter(Boolean);
  };
  const exact = rows.find((r) => hostsOf(r).includes(host));
  const zone = exact ?? rows.find((r) => hostsOf(r).some((h) => host.endsWith(`.${h}`)));
  if (zone && typeof zone.site_tag === "string") return zone.site_tag;
  const seen = rows.flatMap(hostsOf).slice(0, 20).join(", ") || "none";
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))].join(", ") || "none";
  throw new Error(`${host} has no Web Analytics site among the account's ${rows.length} (hosts seen: ${seen}; fields: ${fields}), so there are no visitor measurements.`);
}

async function webVitals(fetchImpl: FetchLike, token: string, account: string, host: string, start: string, end: string) {
  const siteTag = await siteTagFor(fetchImpl, token, account, host);
  const fields = VITALS.flatMap((v) => P.map((p) => `${v}${p}`)).join(" ");
  const query = `query($account: string!, $siteTag: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) { rumWebVitalsEventsAdaptiveGroups(filter: { siteTag: $siteTag, datetime_geq: $start, datetime_leq: $end }, limit: 1) { count quantiles { ${fields} } } } } }`;
  const resp = await fetchImpl(CF_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "capsid (site traffic)" },
    body: JSON.stringify({ query, variables: { account, siteTag, start, end } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  let body: { data?: { viewer?: { accounts?: Array<{ rumWebVitalsEventsAdaptiveGroups?: Array<{ count?: number; quantiles?: Record<string, number> }> }> } }; errors?: Array<{ message?: string }> } | null = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const groups = body?.data?.viewer?.accounts?.[0]?.rumWebVitalsEventsAdaptiveGroups;
  if (!resp.ok || body?.errors?.length || !Array.isArray(groups)) {
    const why = (body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || text).slice(0, 300) || "no message";
    throw new Error(`Cloudflare's analytics query for web vitals answered ${resp.status}: ${why}`);
  }
  const q = groups[0]?.quantiles ?? {};
  // A negative value means Cloudflare has no measurement for it.
  const at = (v: string, p: string) => {
    const n = q[`${v}${p}`];
    return typeof n === "number" && n >= 0 ? n : null;
  };
  const ms = (n: number | null) => (n === null ? null : Math.round(n / 1000));
  const vitals = Object.fromEntries(
    VITALS.map((v) => [v, Object.fromEntries(P.map((p) => [p.toLowerCase(), v === "cumulativeLayoutShift" ? at(v, p) : ms(at(v, p))]))])
  );
  return { page_views_measured: groups[0]?.count ?? 0, unit: "milliseconds, except cumulativeLayoutShift", vitals };
}

// ai_crawlers: the requests each named crawler made, by the status the edge answered, so
// the bot policy (the SEO plan: search and citation bots free, training bots charged or
// blocked, Bytespider denied) shows working: a training bot should get 402 or 403, a
// search bot 200. The names are Prelum's own lists (./robots), the ones every site's
// robots.txt is built from. Google-Extended and Applebot-Extended are robots.txt tokens
// only, never a user agent, so they never show here.
const CRAWLER_CLASSES = [
  ["denied", DENIED_BOTS],
  ["training", AI_TRAINING_BOTS],
  ["ai_search", AI_SEARCH_BOTS],
  ["search", SEARCH_ENGINE_BOTS],
] as const;
// Longest name first, so Claude-SearchBot is not read as a shorter name it contains.
const CRAWLERS = CRAWLER_CLASSES.flatMap(([kind, names]) => names.map((name) => ({ name, kind, lower: name.toLowerCase() }))).sort((a, b) => b.name.length - a.name.length);

// Rows of (user agent, status, hits) to one entry per named crawler. Pure.
function crawlerRows(raw: Array<Record<string, unknown>>) {
  const by = new Map<string, { name: string; kind: string; hits: number; statuses: Record<string, number> }>();
  for (const r of raw) {
    const ua = typeof r.ua === "string" ? r.ua.toLowerCase() : "";
    const bot = CRAWLERS.find((c) => ua.includes(c.lower));
    if (!bot) continue;
    const e = by.get(bot.name) ?? { name: bot.name, kind: bot.kind, hits: 0, statuses: {} };
    const hits = count(r.hits);
    e.hits += hits;
    const status = typeof r.status === "number" || typeof r.status === "string" ? String(r.status) : "?";
    e.statuses[status] = (e.statuses[status] ?? 0) + hits;
    by.set(bot.name, e);
  }
  const order = CRAWLER_CLASSES.map(([kind]) => kind as string);
  return [...by.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.hits - a.hits);
}

export async function siteTraffic(env: Env, namespace: string, args: TrafficArgs, fetchImpl: FetchLike = fetch, now: Date = new Date()) {
  const report: TrafficReport = args.report ?? "not_found";
  const days = args.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TRAFFIC_DAYS) throw new Error(`days must be a whole number from 1 to ${MAX_TRAFFIC_DAYS}.`);
  const limit = args.row_limit ?? 25;

  const site = await reportSite(env, namespace, "traffic report");
  const host = new URL(site.origin).hostname.toLowerCase();
  const creds = cloudflareCredentials(env);
  if (!creds.ok) throw new Error(`The traffic report reads Cloudflare with the watcher's token, and ${creds.reason}.`);

  const start = new Date(now.getTime() - days * DAY_MS).toISOString();
  if (report === "web_vitals") {
    return { namespace, origin: site.origin, report, since: start, ...(await webVitals(fetchImpl, creds.token, creds.account, host, start, now.toISOString())) };
  }
  if (report === "ai_crawlers") {
    const raw = await sql(
      fetchImpl,
      creds.token,
      creds.account,
      `SELECT userAgent AS ua, edgeResponseStatus AS status, COUNT(*) AS hits FROM events.httpRequests WHERE timestamp >= $start AND clientRequestHttpHost = $host GROUP BY userAgent, edgeResponseStatus ORDER BY hits DESC LIMIT ${QUERY_ROWS}`,
      { start, host }
    );
    return {
      namespace,
      origin: site.origin,
      report,
      since: start,
      note: "Sampled, so hits are estimates. The policy: search and ai_search free (200), training charged (402) or blocked (403), denied blocked. A user agent can be faked.",
      crawlers: crawlerRows(raw),
      // The query keeps the busiest user agents; a quiet crawler can fall past the cut.
      truncated: raw.length >= QUERY_ROWS,
    };
  }
  if (report === "server_errors") {
    const raw = await sql(
      fetchImpl,
      creds.token,
      creds.account,
      `SELECT clientRequestPath AS path, edgeResponseStatus AS status, COUNT(*) AS hits FROM events.httpRequests WHERE timestamp >= $start AND clientRequestHttpHost = $host AND edgeResponseStatus >= 500 GROUP BY clientRequestPath, edgeResponseStatus ORDER BY hits DESC LIMIT ${QUERY_ROWS}`,
      { start, host }
    );
    return {
      namespace,
      origin: site.origin,
      report,
      since: start,
      note: "Every 5xx the edge answered, by path and status. Sampled, so hits are estimates; paths are what visitors sent.",
      errors: raw.slice(0, limit).map((r) => ({ path: typeof r.path === "string" ? r.path : "", status: Number(r.status), hits: count(r.hits) })),
      truncated: raw.length > limit,
    };
  }
  const rows = await sql(
    fetchImpl,
    creds.token,
    creds.account,
    `SELECT clientRequestPath AS path, COUNT(*) AS hits FROM events.httpRequests WHERE timestamp >= $start AND clientRequestHttpHost = $host AND edgeResponseStatus = 404 GROUP BY clientRequestPath ORDER BY hits DESC LIMIT ${QUERY_ROWS}`,
    { start, host }
  );
  return {
    namespace,
    origin: site.origin,
    report,
    since: start,
    note: "Cloudflare samples this record, so hits are estimates. probe marks a path scanners try on every site.",
    ...notFoundRows(rows, limit),
  };
}

const HOUR_MS = 3_600_000;

// How many path and status pairs a finding names.
const TOP_5XX = 5;

/**
 * Returned 5xx at the edge per site host, over the most recent complete hour (L6, 2026-10-31):
 * Workers analytics count only invocations that threw, so a Worker that catches its error and
 * answers 500 or 503 was invisible to the error-rate finding. Read from the same SQL API record
 * as the 404 report, sampled, so the counts are estimates. A host with no row had none. Keyed
 * by namespace; a site whose origin is a workers.dev host is not in the record and is left out.
 * Grouped by path and status too: the first findings (2026-10-31) said only "79 answers were
 * 5xx", and nobody could tell which page without a dashboard.
 */
export async function readServerErrors(
  env: Pick<Env, "CF_OPS_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">,
  sites: ReadonlyArray<{ namespace: string; origin: string }>,
  fetchImpl: FetchLike,
  now: Date
): Promise<Record<string, ServerErrors>> {
  const creds = cloudflareCredentials(env);
  if (!creds.ok) throw new Error(creds.reason);
  const end = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const start = new Date(end.getTime() - HOUR_MS);
  const rows = await sql(
    fetchImpl,
    creds.token,
    creds.account,
    `SELECT clientRequestHttpHost AS host, clientRequestPath AS path, edgeResponseStatus AS status, COUNT(*) AS hits FROM events.httpRequests WHERE timestamp >= $start AND timestamp < $end AND edgeResponseStatus >= 500 GROUP BY clientRequestHttpHost, clientRequestPath, edgeResponseStatus ORDER BY hits DESC LIMIT ${QUERY_ROWS}`,
    { start: start.toISOString(), end: end.toISOString() }
  );
  const byHost = new Map<string, ServerErrors>();
  for (const r of rows) {
    const host = typeof r.host === "string" ? r.host.toLowerCase() : "";
    const e = byHost.get(host) ?? { count: 0, top: [] };
    const hits = count(r.hits);
    e.count += hits;
    if (e.top.length < TOP_5XX) e.top.push({ path: typeof r.path === "string" ? r.path : "", status: Number(r.status), hits });
    byHost.set(host, e);
  }
  const out: Record<string, ServerErrors> = {};
  for (const site of sites) {
    const host = new URL(site.origin).hostname.toLowerCase();
    if (host.endsWith(".workers.dev")) continue;
    out[site.namespace] = byHost.get(host) ?? { count: 0, top: [] };
  }
  return out;
}
