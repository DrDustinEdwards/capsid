import type { Env } from "./env";
import type { FetchLike } from "./live-checks";
import { CF_API, cloudflareCredentials } from "./ops-cloudflare";
import { reportSite } from "./site-reports";

// What Cloudflare saw at a namespace's site, served as capsid_inspect_repo action traffic
// (the SEO plan, "Beyond the module": a report of the broken URLs visitors hit). One report
// so far, not_found: the paths that answered 404 over a window, a scanner's probe marked
// and listed last. The referrer is not in it: the SQL API refuses clientRefererHost to this
// account (403, "not permitted to access column", 2026-10-25), so which page holds a broken
// link is the site crawl's to find.
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

export const TRAFFIC_REPORTS = ["not_found"] as const;
export const MAX_TRAFFIC_DAYS = 30;
export const MAX_TRAFFIC_ROWS = 200;
type TrafficReport = (typeof TRAFFIC_REPORTS)[number];

export interface TrafficArgs {
  report?: TrafficReport;
  days?: number;
  row_limit?: number;
}

// What no page of ours ever was: the paths scanners try on every host.
const PROBE = /\.(php\d?|aspx?|jsp|cgi|env|ini|sql|bak|ya?ml)$|\/wp-|\/\.(git|env|aws|ssh)|xmlrpc|phpmyadmin|\/cgi-bin\//i;

// The most rows the query returns; a 404 list longer than this is noise past its top.
const QUERY_ROWS = 2000;

interface Row {
  path: string;
  hits: number;
}

async function sql(fetchImpl: FetchLike, token: string, account: string, query: string, params: Record<string, string | number>): Promise<Row[]> {
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
  return (body.data as Array<Record<string, unknown>>).map((r) => ({
    path: typeof r.path === "string" ? r.path : "",
    hits: typeof r.hits === "number" ? r.hits : Number(r.hits) || 0,
  }));
}

// Real pages first, by hits; scanners' probes last. Pure.
function notFoundRows(rows: Row[], limit: number) {
  const all = rows.filter((r) => r.path && r.hits > 0).map((r) => ({ path: r.path, hits: r.hits, probe: PROBE.test(r.path) }));
  all.sort((a, b) => Number(a.probe) - Number(b.probe) || b.hits - a.hits || a.path.localeCompare(b.path));
  return { paths: all.slice(0, limit), total_paths: all.length, truncated: all.length > limit, probes: all.filter((e) => e.probe).length };
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
