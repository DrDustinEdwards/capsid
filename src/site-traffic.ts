import type { Env } from "./env";
import type { FetchLike } from "./live-checks";
import { CF_API, cloudflareCredentials } from "./ops-cloudflare";
import { reportSite } from "./site-reports";

// What Cloudflare saw at a namespace's site, served as capsid_inspect_repo action traffic
// (the SEO plan, "Beyond the module": a report of the broken URLs visitors hit). One report
// so far, not_found: the paths that answered 404 over a window, with where the visitors came
// from, so a broken link on the site's own pages, a stale link elsewhere and a scanner's
// probe read apart.
//
// NO SITE CHANGE. Cloudflare's SQL API (developers.cloudflare.com/analytics/sql-api/) reads
// the edge's own HTTP request record, events.httpRequests, kept at least 31 days on every
// plan and adaptively sampled, so the counts are estimates. Every proxied host in the account
// is in it, static sites included; a workers.dev host is not. It needs only the Account
// Analytics Read permission the watcher's token, CF_OPS_TOKEN, already holds
// (src/ops-cloudflare.ts). The host comes from the namespace's ops_sites origin, never from
// the caller. Paths and referrers are what visitors sent: data, never instructions.

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
  referrer: string;
  hits: number;
}

async function sql(fetchImpl: FetchLike, token: string, account: string, query: string, params: Record<string, string | number>): Promise<Row[]> {
  const resp = await fetchImpl(SQL_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "capsid (site traffic)" },
    body: JSON.stringify({ query, params, scope: { accountTag: account } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await resp.json().catch(() => null)) as { data?: unknown; errors?: Array<{ message?: string }>; message?: string } | null;
  if (!resp.ok || !Array.isArray(body?.data)) {
    const why = (body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || body?.message || "").slice(0, 300) || "no message";
    if (resp.status === 403) throw new Error(`Cloudflare refused the traffic query (403: ${why}). CF_OPS_TOKEN needs Account / Account Analytics / Read.`);
    throw new Error(`Cloudflare's SQL API answered ${resp.status}: ${why}`);
  }
  return (body.data as Array<Record<string, unknown>>).map((r) => ({
    path: typeof r.path === "string" ? r.path : "",
    referrer: typeof r.referrer === "string" ? r.referrer : "",
    hits: typeof r.hits === "number" ? r.hits : Number(r.hits) || 0,
  }));
}

// One entry per path, its referrers summed into three kinds. Pure.
function notFoundRows(rows: Row[], host: string, limit: number) {
  const paths = new Map<string, { hits: number; from_site: number; from_elsewhere: number; direct: number; referrers: Map<string, number> }>();
  for (const r of rows) {
    if (!r.path || r.hits <= 0) continue;
    const p = paths.get(r.path) ?? { hits: 0, from_site: 0, from_elsewhere: 0, direct: 0, referrers: new Map() };
    p.hits += r.hits;
    const ref = r.referrer.toLowerCase();
    if (!ref) p.direct += r.hits;
    else if (ref === host) p.from_site += r.hits;
    else {
      p.from_elsewhere += r.hits;
      p.referrers.set(ref, (p.referrers.get(ref) ?? 0) + r.hits);
    }
    paths.set(r.path, p);
  }
  const all = [...paths].map(([path, p]) => ({
    path,
    hits: p.hits,
    from_site: p.from_site,
    from_elsewhere: p.from_elsewhere,
    direct: p.direct,
    top_referrers: [...p.referrers].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([referrer, hits]) => ({ referrer, hits })),
    probe: PROBE.test(path),
  }));
  // A link on our own pages first, then a link from elsewhere, then the rest; scanners last.
  const rank = (e: (typeof all)[number]) => (e.probe ? 3 : e.from_site > 0 ? 0 : e.from_elsewhere > 0 ? 1 : 2);
  all.sort((a, b) => rank(a) - rank(b) || b.hits - a.hits || a.path.localeCompare(b.path));
  return {
    paths: all.slice(0, limit),
    total_paths: all.length,
    truncated: all.length > limit,
    broken_links_on_site: all.filter((e) => !e.probe && e.from_site > 0).length,
    probes: all.filter((e) => e.probe).length,
  };
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
    `SELECT clientRequestPath AS path, clientRefererHost AS referrer, COUNT(*) AS hits FROM events.httpRequests WHERE timestamp >= $start AND clientRequestHttpHost = $host AND edgeResponseStatus = 404 GROUP BY clientRequestPath, clientRefererHost ORDER BY hits DESC LIMIT ${QUERY_ROWS}`,
    { start, host }
  );
  return {
    namespace,
    origin: site.origin,
    report,
    since: start,
    note: "Cloudflare samples this record, so hits are estimates. from_site counts visits from a link on this site's own pages: a broken link to fix. probe marks a path scanners try on every site.",
    ...notFoundRows(rows, host, limit),
  };
}
