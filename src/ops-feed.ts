import { opsLive } from "./ops-live";
import { adminAgentForEmail } from "./agents";
import { capsidCookie } from "./auth";
import { readCookie } from "@dustinedwards/site-runtime/headers";
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_PREFIX,
  PORTAL_SESSION_TTL_SECONDS,
  type PortalUser,
  portalDisplay,
  behindGate,
  sourceAddress,
} from "./portal-auth";
import { portalCookiePath } from "./portal-host";
import type { Env } from "./env";
import { readSnapshot } from "./ops-snapshot";
import type { OpsFeed, OpsUptime, OpsUptimeCounts } from "./ops-types/feed";
import { DAILY_RETENTION_DAYS } from "./backup";
import { auditStatement } from "./store-guards";
import { readTaskRuns, taskStates, TASKS } from "./task-runs";
import { DEFAULT_CADENCE_MINUTES, watcherTick, type Gathered, type WatcherReport } from "./watcher";
import { gatherFindings } from "./watcher-gather";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { warningHeaders } from "./http";
import { jsonResponse, textResponse } from "@dustinedwards/site-runtime/http";
import { MINUTE_MS, DAY_MS } from "./time";

// The Watch Floor's one read (capsid/research/design-ops-console.md): GET /portal/api/ops returns OpsFeed (src/ops-types/feed.ts), the watcher's last pass from KV plus what changes between passes, read live. POST /portal/api/ops/refresh runs one watcher pass now and returns the new feed. Both answer to portalGate; they are routes, not tools, so no grant is checked here (src/scope.ts lists them among the routes gated some other way).
//
// READS PER FEED REQUEST, stated because the dashboard polls this and a per-namespace loop would multiply them. Asserted by test-integration/ops-feed.test.ts, which counts.
//   D1, 13 statements plus one per TASKS entry (18 today, so 31):
//     1  jobs: every open job and every job that ended in the last 24 hours
//     3  agentSummaries: the inventory, then loadRecordRows' two grouped reads
//     1  job_outcome_prs in the last 7 days
//     1  ops_sites, 1  ops_packages: the configuration, every row
//    18  task_runs: each task's newest runs, one keyed read per task in one batch
//     1  watcher_findings: the open findings that post no job (src/watcher-digest.ts)
//     1  ops_uptime_daily: each site's last 90 days, by month (siteUptime below)
//     4  gatherInbox (src/inbox.ts): the blocked jobs, the claimed and due parked jobs
//        with their newest audit rows, the applied migrations and the site configuration
//        again, so Needs you counts exactly what GET /ops/inbox answers with
//   KV, 10 gets: gatherInbox's own reads (stale pull request cache, manual steps cache,
//     ops:snapshot, the awaiting-seat set, the merge units' report), then ops:snapshot,
//     the awaiting-seat set, the auto-merge safety report, the refresh stamp, and the
//     overnight switch's mode (its decision record only while the mode is subscription).
// They run concurrently; the longest chain is agentSummaries' two steps.

export const OPS_FEED_PATH = "/portal/api/ops";
export const OPS_REFRESH_PATH = "/portal/api/ops/refresh";
// Where a sign-in started from one of these routes lands afterwards: the app.
export const OPS_RETURN_TO = PORTAL_PREFIX;

// D1 statements: one per task, and 15 more, one of them the signed policy's read (liveMergePolicy).
export const OPS_FEED_READS = { d1: 14 + TASKS.length, kv: 10 } as const;

// The uptime target the Portal shows each site against.
const UPTIME_TARGET = 0.999;

/** Each site's probes and up probes over the retention window, and the days under the
 *  target. Null, logged, when the table cannot be read (before migrations/0054). */
async function siteUptime(env: Env, now: Date): Promise<OpsUptime | null> {
  const since = new Date(now.getTime() - (DAILY_RETENTION_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  try {
    const { results } = await env.DB.prepare(
      `SELECT namespace, substr(day, 1, 7) AS month, SUM(probes) AS probes, SUM(up) AS up, COUNT(*) AS days,
              SUM(CASE WHEN up * 1000 < probes * 999 THEN 1 ELSE 0 END) AS below
       FROM ops_uptime_daily WHERE day >= ?1 GROUP BY namespace, month ORDER BY namespace, month`,
    )
      .bind(since)
      .all<{ namespace: string; month: string } & OpsUptimeCounts>();
    // One row per site and month, folded into each site's totals and its months.
    const sites = new Map<string, OpsUptime["sites"][number]>();
    for (const { namespace, month, probes, up, days, below } of results ?? []) {
      const s = sites.get(namespace) ?? {
        namespace,
        probes: 0,
        up: 0,
        days: 0,
        below: 0,
        months: [],
      };
      s.probes += probes;
      s.up += up;
      s.days += days;
      s.below += below;
      s.months.push({ month, probes, up, days, below });
      sites.set(namespace, s);
    }
    return { target: UPTIME_TARGET, days: DAILY_RETENTION_DAYS, sites: [...sites.values()] };
  } catch (err) {
    logEvent(
      "OPS_FEED_UPTIME_UNREADABLE",
      { message: `OPS_FEED_UPTIME_UNREADABLE ${errorMessage(err)}` },
      { level: "error" },
    );
    return null;
  }
}

// The Portal's double-submit CSRF cookie (OpsFeed.csrf), named in src/portal-auth.ts.
// Minted when absent or malformed and then left alone, never rotated per poll, so a
// preview and its perform carry one value.
export { PORTAL_CSRF_COOKIE };
const CSRF_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The request's Portal CSRF value, and the Set-Cookie that mints one when it has none. */
export function portalCsrf(request: Request): { value: string; setCookie: string | null } {
  const presented = readCookie(request, PORTAL_CSRF_COOKIE);
  if (presented !== null && CSRF_SHAPE.test(presented))
    return { value: presented, setCookie: null };
  const value = crypto.randomUUID();
  const path = portalCookiePath(new URL(request.url));
  return {
    value,
    setCookie: capsidCookie(PORTAL_CSRF_COOKIE, value, path, PORTAL_SESSION_TTL_SECONDS),
  };
}

// The refresh's rate limit: one on-demand pass per two minutes, stamped in KV.
export const OPS_REFRESH_KEY = "ops:refresh:last";
const OPS_REFRESH_INTERVAL_MS = 2 * MINUTE_MS;
// A cross-site form cannot set a custom header, and a cross-site fetch that sets one
// is preflighted and refused, so its presence says the request came from this origin.
export const OPS_REFRESH_HEADER = "X-Capsid-Ops";
const OPS_REFRESH_HEADER_VALUE = "refresh";

/** When the next on-demand pass is allowed, or null when one is allowed now. A stamp
 *  that does not parse allows one: the limiter's put writes a fresh stamp. */
export function refreshAllowedAt(last: string | null, now: Date): string | null {
  if (last === null) return null;
  const at = Date.parse(last);
  if (Number.isNaN(at)) return null;
  const next = at + OPS_REFRESH_INTERVAL_MS;
  return next > now.getTime() ? new Date(next).toISOString() : null;
}

// The feed without its csrf, which comes off the request (portalCsrf) and is added by
// the handler, so opsFeed reads storage only.
export type OpsFeedData = Omit<OpsFeed, "csrf" | "user">;

/** The run ledger as the feed shows it. A failed read is said in the panel, not
 *  turned into a failure of the whole feed. */
async function scheduled(
  env: Env,
): Promise<{ read: Awaited<ReturnType<typeof readTaskRuns>> } | { error: string }> {
  try {
    return { read: await readTaskRuns(env.DB) };
  } catch (err) {
    const message = errorMessage(err);
    logEvent(
      "OPS_FEED_TASK_RUNS_UNREADABLE",
      { message: `OPS_FEED_TASK_RUNS_UNREADABLE ${message}` },
      { level: "error" },
    );
    return { error: message };
  }
}

export async function opsFeed(env: Env, now: Date): Promise<OpsFeedData> {
  const [snapshot, live, last, runs, uptime] = await Promise.all([
    readSnapshot(env),
    opsLive(env, now),
    env.APP_KV.get(OPS_REFRESH_KEY),
    scheduled(env),
    siteUptime(env, now),
  ]);
  return {
    snapshot,
    uptime,
    live,
    scheduled:
      "error" in runs
        ? { tasks: null, error: runs.error }
        : {
            tasks: taskStates(runs.read, now, snapshot?.cadence_min ?? DEFAULT_CADENCE_MINUTES),
            error: null,
          },
    refresh_allowed_at: refreshAllowedAt(last, now),
    cloudflare_configured: Boolean(env.CF_OPS_TOKEN),
  };
}

function opsFeedAnswer(
  request: Request,
  user: PortalUser,
  data: OpsFeedData,
  extra: Record<string, string> = {},
): Response {
  const csrf = portalCsrf(request);
  const feed: OpsFeed = { ...data, csrf: csrf.value, user: portalDisplay(user) };
  return jsonResponse(feed, 200, {
    ...extra,
    ...(csrf.setCookie ? { "Set-Cookie": csrf.setCookie } : {}),
  });
}

// What the two handlers can be handed in a test in place of the live reads. The
// watcher pass itself is not injectable: the refresh always calls watcherTick with
// force, and only the gather under it is swapped.
export interface OpsDeps {
  feed?: (env: Env, now: Date) => Promise<OpsFeedData>;
  gather?: (env: Env, now: Date) => Promise<Gathered>;
}

export const handleOpsFeed = behindGate(async (request, env, now, user, deps: OpsDeps = {}) =>
  opsFeedAnswer(request, user, await (deps.feed ?? opsFeed)(env, now)),
);

export const handleOpsRefresh = behindGate(async (request, env, now, user, deps: OpsDeps = {}) => {
  if (request.headers.get(OPS_REFRESH_HEADER) !== OPS_REFRESH_HEADER_VALUE) {
    return textResponse(
      `forbidden: a refresh must carry the header ${OPS_REFRESH_HEADER}: ${OPS_REFRESH_HEADER_VALUE}. The dashboard sends it; a cross-site form cannot.`,
      403,
    );
  }

  // The rate limit fails closed: a stamp that cannot be read or written refuses the
  // pass, because an unlimited Refresh is a button that runs every GitHub read the
  // watcher makes as often as it is clicked.
  let last: string | null;
  try {
    last = await env.APP_KV.get(OPS_REFRESH_KEY);
  } catch (err) {
    const message = errorMessage(err);
    logEvent(
      "OPS_REFRESH_LIMIT_UNREADABLE",
      { message: `OPS_REFRESH_LIMIT_UNREADABLE ${message}` },
      { level: "error" },
    );
    return textResponse(
      `the refresh rate limit could not be read (${message}), so no pass was run. Try again shortly.`,
      503,
    );
  }
  const allowedAt = refreshAllowedAt(last, now);
  if (allowedAt !== null) {
    const seconds = Math.max(1, Math.ceil((Date.parse(allowedAt) - now.getTime()) / 1000));
    return textResponse(
      `a watcher pass was run on demand less than two minutes ago. The next is allowed at ${allowedAt}.`,
      429,
      {
        "Retry-After": String(seconds),
      },
    );
  }
  try {
    await env.APP_KV.put(OPS_REFRESH_KEY, now.toISOString());
  } catch (err) {
    const message = errorMessage(err);
    logEvent(
      "OPS_REFRESH_LIMIT_UNWRITABLE",
      { message: `OPS_REFRESH_LIMIT_UNWRITABLE ${message}` },
      { level: "error" },
    );
    return textResponse(
      `the refresh rate limit could not be written (${message}), so no pass was run. Try again shortly.`,
      503,
    );
  }

  const actor = adminAgentForEmail(user.email).actor;
  const gather = deps.gather ?? gatherFindings;
  let report: WatcherReport;
  try {
    report = await watcherTick(env, now, () => gather(env, now), { force: true });
  } catch (err) {
    const message = errorMessage(err);
    logEvent(
      "OPS_REFRESH_PASS_FAILED",
      { message: `OPS_REFRESH_PASS_FAILED ${message}` },
      { level: "error" },
    );
    await env.DB.batch([
      auditStatement(env.DB, actor, "portal-ops-refresh", null, null, {
        ran: false,
        error: message,
        source_address: sourceAddress(request),
      }),
    ]);
    return textResponse(`the watcher pass failed: ${message}`, 500);
  }

  // The click's own audit row, as every Portal action writes one (src/portal-actions.ts).
  let warning: string | null = null;
  try {
    await env.DB.batch([
      auditStatement(env.DB, actor, "portal-ops-refresh", null, null, {
        ran: report.ran,
        note: report.note,
        posted: report.posted,
        cleared: report.cleared,
        source_address: sourceAddress(request),
      }),
    ]);
  } catch (err) {
    // The pass happened; only its audit row failed. Said in a header and the log, not
    // turned into a failure of a pass that ran.
    warning = `the pass ran, but the Portal audit row naming ${actor} was not written: ${errorMessage(err)}`;
    logEvent("OPS_REFRESH_AUDIT_FAILED", { message: warning }, { level: "error" });
  }
  const feed = await (deps.feed ?? opsFeed)(env, now);
  return opsFeedAnswer(request, user, feed, warningHeaders(warning));
});
