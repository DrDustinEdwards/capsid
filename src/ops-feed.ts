import { adminAgentForEmail } from "./agents";
import { getCookie } from "./auth";
import { AWAITING_SEAT_KEY } from "./auto-merge-tick";
import { PORTAL_CSRF_COOKIE, PORTAL_PATH, PORTAL_PREFIX, PORTAL_SESSION_TTL_SECONDS, portalGate } from "./portal-auth";
import type { Env } from "./env";
import { agentSummaries, checkBudget, type AgentSummary } from "./improve-run";
import { ROSTER } from "./improve-schema";
import { pausedReason, readMode } from "./improve-state";
import { commandFromSummary, RESUME_MARKER } from "./jobs-holder";
import { OPEN_JOB_STATUSES } from "./jobs-schema";
import { readSiteConfig } from "./ops-sites";
import { readSnapshot } from "./ops-snapshot";
import type { OpsAgent, OpsAwaitingSeat, OpsFeed, OpsJob, OpsJobStatus, OpsLive, OpsPr, OpsSeatStart } from "./ops-types";
import { runUrl } from "./runner-key";
import { seatStartState, sessionsInFlight } from "./seat-start";
import { auditStatement } from "./store-guards";
import { gatherFindings, watcherTick, WATCHER_ACTOR, type Gathered, type WatcherReport } from "./watcher";

// The Watch Floor's one read (capsid/research/design-ops-console.md): GET
// /portal/api/ops returns OpsFeed (src/ops-types.ts), the watcher's last pass from KV
// plus what changes between passes, read live. POST /portal/api/ops/refresh runs one
// watcher pass now and returns the new feed.
//
// Both answer to portalGate, as every Portal route does: the administrator's Access
// session and ADMIN_EMAIL on every request, and a 403 for any Authorization header.
// They are routes, not tools, so no grant is checked here (CLAUDE.md, one enforcement
// point rule); src/scope.ts lists them among the routes gated some other way.
//
// READS PER FEED REQUEST, stated because the dashboard polls this and a per-namespace
// loop would multiply them. Asserted by test-integration/ops-feed.test.ts, which counts.
//   D1, 11 statements plus N:
//     1  jobs: every open job and every job that ended in the last 24 hours
//     4  agentSummaries: the inventory, then loadRecordRows' three grouped reads
//     1  job_outcome_prs in the last 7 days
//     1  audit_log: seat starts and runner-key mints in the last 7 days
//     2  sessionsInFlight: runner-held jobs, and starts inside the pending window,
//        plus N = one readJob per such start not already held (at most the cap in use)
//     1  checkBudget's month spend
//     1  ops_sites: the site configuration, every row
//   KV, 7 gets plus one per ROSTER namespace (5 today, so 12): ops:snapshot, the
//     awaiting-seat set, the refresh stamp, the improve mode, the budget caps,
//     seatStartState's two keys, and each namespace's pause key.
// They run concurrently; the longest chain is agentSummaries' two steps.

export const OPS_FEED_PATH = "/portal/api/ops";
export const OPS_REFRESH_PATH = "/portal/api/ops/refresh";
// Where a sign-in started from one of these routes lands afterwards: the app.
export const OPS_RETURN_TO = PORTAL_PREFIX;

export const OPS_FEED_READS = { d1: 11, kv: 7 + ROSTER.length } as const;

// The Portal's double-submit CSRF cookie (OpsFeed.csrf), named in src/portal-auth.ts.
// Minted when absent or malformed and then left alone, never rotated per poll, so a
// preview and its perform carry one value.
export { PORTAL_CSRF_COOKIE };
const CSRF_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The request's Portal CSRF value, and the Set-Cookie that mints one when it has none. */
function portalCsrf(request: Request): { value: string; setCookie: string | null } {
  const presented = getCookie(request, PORTAL_CSRF_COOKIE);
  if (presented !== null && CSRF_SHAPE.test(presented)) return { value: presented, setCookie: null };
  const value = crypto.randomUUID();
  return {
    value,
    setCookie: `${PORTAL_CSRF_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${PORTAL_PATH}; Max-Age=${PORTAL_SESSION_TTL_SECONDS}`,
  };
}

// The refresh's rate limit: one on-demand pass per two minutes, stamped in KV.
export const OPS_REFRESH_KEY = "ops:refresh:last";
const OPS_REFRESH_INTERVAL_MS = 2 * 60_000;
// A cross-site form cannot set a custom header, and a cross-site fetch that sets one
// is preflighted and refused, so its presence says the request came from this origin.
export const OPS_REFRESH_HEADER = "X-Capsid-Ops";
const OPS_REFRESH_HEADER_VALUE = "refresh";

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
// The seat-start read's bound. Starts are rare (a cap of one or two in flight), so a
// week of them is far under this; the LIMIT is a guard, not a page.
const SEAT_ROWS_LIMIT = 500;

// D1's datetime('now') text form, for comparing against columns written by default.
const sqliteTime = (at: Date): string => at.toISOString().slice(0, 19).replace("T", " ");

/** An instant as ISO. Columns written by datetime('now') read "YYYY-MM-DD HH:MM:SS",
 *  which is UTC but which a browser's Date.parse reads as local time, so the feed
 *  hands every timestamp over in one unambiguous form. Anything else passes through. */
export function isoTime(value: string): string;
export function isoTime(value: string | null): string | null;
export function isoTime(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

export interface JobFeedRow {
  id: string;
  namespace: string;
  title: string;
  status: string;
  priority: number;
  posted_by: string;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
  lease_expires: string | null;
  blocked_count: number;
  resumed_count: number;
  gate_required: number;
  result_ref: string | null;
  result_summary: string | null;
}

// The watcher's title carries its fingerprint in brackets at the end. The same
// pattern openWatcherFingerprints (src/watcher.ts) reads it with; test/ops-feed.test.ts
// runs both over one set of titles so the two cannot disagree.
const FINGERPRINT = /\[([^\]]+)\]\s*$/;

/** A job as the feed shows it. A blocked job's summary is split into what it waits on
 *  and the exact command (commandFromSummary), so the app can show the command to copy. */
export function opsJobFrom(row: JobFeedRow): OpsJob {
  const blocked = row.status === "blocked";
  const summary = row.result_summary;
  const marker = summary === null ? -1 : summary.indexOf(RESUME_MARKER);
  const waitsOn = !blocked || summary === null ? null : (marker === -1 ? summary : summary.slice(0, marker)).trim() || null;
  const print = row.posted_by === WATCHER_ACTOR ? FINGERPRINT.exec(row.title) : null;
  return {
    id: row.id,
    namespace: row.namespace,
    title: row.title,
    status: row.status as OpsJobStatus,
    priority: row.priority,
    posted_by: row.posted_by,
    claimed_by: row.claimed_by,
    created_at: isoTime(row.created_at),
    updated_at: isoTime(row.updated_at),
    lease_expires: isoTime(row.lease_expires),
    blocked_count: row.blocked_count,
    resumed_count: row.resumed_count,
    gate_required: row.gate_required === 1,
    waits_on: waitsOn,
    command: blocked ? commandFromSummary(summary) : null,
    result_ref: row.result_ref,
    finding: print ? { fingerprint: print[1] } : null,
  };
}

/** One credential as the feed shows it: the inventory improve_status serves, with its
 *  record. Grants are left out; the contract carries flags only. */
export function opsAgentFrom(agent: AgentSummary): OpsAgent {
  const r = agent.record;
  return {
    name: agent.name,
    kind: agent.kind,
    namespaces: agent.namespaces,
    flags: agent.flags,
    last_seen: isoTime(agent.last_seen),
    revoked_at: isoTime(agent.revoked_at),
    jobs_done: r.jobs_done,
    jobs_failed: r.jobs_failed,
    jobs_blocked: r.jobs_blocked,
    prs_opened: r.prs_opened,
    prs_merged: r.prs_merged,
    pr_merge_rate: r.pr_merge_rate,
    ci_green_rate: r.ci_green_rate,
    median_duration_minutes: r.median_duration_minutes,
    attempts_kept: r.attempts_kept,
    attempts_reverted: r.attempts_reverted,
  };
}

export interface SeatAuditRow {
  id: number;
  action: string;
  namespace: string | null;
  params: string;
  at: string;
}

function paramsOf(row: SeatAuditRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.params);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("not an object");
  } catch (err) {
    // This Worker wrote the row, so a params that does not parse is a defect to see,
    // not a start to hide: it is logged, and the start is listed with no run.
    console.error(`OPS_FEED_AUDIT_PARAMS_UNREADABLE audit_log ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** Seat starts, newest first, each joined to the runner-key mint that names it
 *  (start_audit_id). A start whose runner never presented its token has no run. */
export function seatRecentFrom(rows: SeatAuditRow[]): OpsSeatStart["recent"] {
  const mints = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (row.action !== "runner-key-minted") continue;
    const params = paramsOf(row);
    if (typeof params.start_audit_id === "number") mints.set(params.start_audit_id, params);
  }
  return rows
    .filter((row) => row.action === "job-seat-started")
    .sort((a, b) => b.id - a.id)
    .map((row) => {
      const start = paramsOf(row);
      const mint = mints.get(row.id);
      const runId = mint ? Number(mint.run_id) : NaN;
      const recorded = typeof mint?.run_url === "string" ? mint.run_url : null;
      // A mint written before run_url was recorded: the URL is built the same way from
      // the repo the start dispatched to.
      const url = mint ? (recorded ?? (typeof start.repo === "string" ? runUrl(start.repo, mint.run_id) : null)) : null;
      return {
        job_id: typeof start.job_id === "string" ? start.job_id : "",
        namespace: row.namespace,
        at: isoTime(row.at),
        run_id: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
        run_url: url,
      };
    });
}

/** The auto-merge tick's awaiting-seat set. A value that does not parse is logged and
 *  shown as empty, because the contract has no field to carry the reason; a KV read
 *  that fails throws and fails the feed. */
export function awaitingFrom(raw: string | null): OpsAwaitingSeat[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as OpsAwaitingSeat[];
  } catch (err) {
    console.error(`OPS_FEED_AWAITING_UNREADABLE ${AWAITING_SEAT_KEY}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** When the next on-demand pass is allowed, or null when one is allowed now. A stamp
 *  that does not parse allows one: the limiter's put writes a fresh stamp. */
export function refreshAllowedAt(last: string | null, now: Date): string | null {
  if (last === null) return null;
  const at = Date.parse(last);
  if (Number.isNaN(at)) return null;
  const next = at + OPS_REFRESH_INTERVAL_MS;
  return next > now.getTime() ? new Date(next).toISOString() : null;
}

async function liveJobs(db: D1Database, now: Date): Promise<OpsJob[]> {
  const open = OPEN_JOB_STATUSES.map((_, i) => `?${i + 2}`).join(", ");
  // datetime() on both sides: updated_at is written both as ISO and as D1's default
  // text form, and the two do not compare as text.
  const { results } = await db
    .prepare(
      `SELECT id, namespace, title, status, priority, posted_by, claimed_by, created_at, updated_at, lease_expires,
              blocked_count, resumed_count, gate_required, result_ref, result_summary
       FROM jobs WHERE status IN (${open}) OR datetime(updated_at) >= datetime(?1)
       ORDER BY updated_at DESC`
    )
    .bind(new Date(now.getTime() - DAY_MS).toISOString(), ...OPEN_JOB_STATUSES)
    .all<JobFeedRow>();
  return (results ?? []).map(opsJobFrom);
}

async function livePrs(db: D1Database, now: Date): Promise<OpsPr[]> {
  const { results } = await db
    .prepare(
      `SELECT job_id, pr_url, merged, merge_verified_at, recorded_at FROM job_outcome_prs
       WHERE recorded_at >= ?1 ORDER BY recorded_at DESC`
    )
    .bind(sqliteTime(new Date(now.getTime() - WEEK_MS)))
    .all<{ job_id: string; pr_url: string; merged: number | null; merge_verified_at: string | null; recorded_at: string }>();
  return (results ?? []).map((r) => ({
    job_id: r.job_id,
    pr_url: r.pr_url,
    // Three states, kept: null is never checked, not closed (migrations/0015).
    merged: r.merged === null ? null : r.merged === 1,
    merge_verified_at: isoTime(r.merge_verified_at),
    recorded_at: isoTime(r.recorded_at),
  }));
}

async function seatRows(db: D1Database, now: Date): Promise<SeatAuditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, action, namespace, params, at FROM audit_log
       WHERE action IN ('job-seat-started', 'runner-key-minted') AND at >= ?1
       ORDER BY id DESC LIMIT ?2`
    )
    .bind(sqliteTime(new Date(now.getTime() - WEEK_MS)), SEAT_ROWS_LIMIT)
    .all<SeatAuditRow>();
  return results ?? [];
}

async function liveLoop(env: Env, now: Date): Promise<OpsLive["loop"]> {
  const [{ mode }, budget] = await Promise.all([readMode(env.APP_KV), checkBudget(env, now)]);
  // checkBudget's reason is prose for a refusal; the app states the numbers itself.
  return { mode, budget: { month: budget.month, caps: budget.caps, spend: budget.spend, exceeded: budget.exceeded } };
}

export async function opsLive(env: Env, now: Date): Promise<OpsLive> {
  const [jobs, agents, prs, awaitingRaw, seat, inFlight, rows, loop, namespaces, sites] = await Promise.all([
    liveJobs(env.DB, now),
    agentSummaries(env.DB),
    livePrs(env.DB, now),
    env.APP_KV.get(AWAITING_SEAT_KEY),
    seatStartState(env),
    sessionsInFlight(env, now),
    seatRows(env.DB, now),
    liveLoop(env, now),
    // Read as the loop reads it (pausedReason), so an unreadable key shows as a pause
    // with its reason, the way the loop treats it.
    Promise.all(ROSTER.map(async (name) => ({ name, paused: await pausedReason(env.APP_KV, name) }))),
    readSiteConfig(env.DB),
  ]);
  return {
    generated: now.toISOString(),
    jobs,
    agents: agents.map(opsAgentFrom),
    prs,
    awaiting_seat: awaitingFrom(awaitingRaw),
    seat_start: { enabled: seat.enabled, max_sessions: seat.max_sessions, in_flight: inFlight.length, recent: seatRecentFrom(rows) },
    loop,
    namespaces,
    sites,
  };
}

// The feed without its csrf, which comes off the request (portalCsrf) and is added by
// the handler, so opsFeed reads storage only.
export type OpsFeedData = Omit<OpsFeed, "csrf">;

export async function opsFeed(env: Env, now: Date): Promise<OpsFeedData> {
  const [snapshot, live, last] = await Promise.all([readSnapshot(env), opsLive(env, now), env.APP_KV.get(OPS_REFRESH_KEY)]);
  return {
    snapshot,
    live,
    refresh_allowed_at: refreshAllowedAt(last, now),
    cloudflare_configured: Boolean(env.CF_OPS_TOKEN),
  };
}

function feedResponse(request: Request, data: OpsFeedData, extra: Record<string, string> = {}): Response {
  const csrf = portalCsrf(request);
  const feed: OpsFeed = { ...data, csrf: csrf.value };
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  if (csrf.setCookie) headers.set("Set-Cookie", csrf.setCookie);
  return new Response(JSON.stringify(feed), { status: 200, headers });
}

function textResponse(message: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

// What the two handlers can be handed in a test in place of the live reads. The
// watcher pass itself is not injectable: the refresh always calls watcherTick with
// force, and only the gather under it is swapped.
export interface OpsDeps {
  feed?: (env: Env, now: Date) => Promise<OpsFeedData>;
  gather?: (env: Env, now: Date) => Promise<Gathered>;
}

export async function handleOpsFeed(request: Request, env: Env, now: Date = new Date(), deps: OpsDeps = {}): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  return feedResponse(request, await (deps.feed ?? opsFeed)(env, now));
}

export async function handleOpsRefresh(request: Request, env: Env, now: Date = new Date(), deps: OpsDeps = {}): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  if (request.headers.get(OPS_REFRESH_HEADER) !== OPS_REFRESH_HEADER_VALUE) {
    return textResponse(`forbidden: a refresh must carry the header ${OPS_REFRESH_HEADER}: ${OPS_REFRESH_HEADER_VALUE}. The dashboard sends it; a cross-site form cannot.`, 403);
  }

  // The rate limit fails closed: a stamp that cannot be read or written refuses the
  // pass, because an unlimited Refresh is a button that runs every GitHub read the
  // watcher makes as often as it is clicked.
  let last: string | null;
  try {
    last = await env.APP_KV.get(OPS_REFRESH_KEY);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`OPS_REFRESH_LIMIT_UNREADABLE ${message}`);
    return textResponse(`the refresh rate limit could not be read (${message}), so no pass was run. Try again shortly.`, 503);
  }
  const allowedAt = refreshAllowedAt(last, now);
  if (allowedAt !== null) {
    const seconds = Math.max(1, Math.ceil((Date.parse(allowedAt) - now.getTime()) / 1000));
    return textResponse(`a watcher pass was run on demand less than two minutes ago. The next is allowed at ${allowedAt}.`, 429, {
      "Retry-After": String(seconds),
    });
  }
  try {
    await env.APP_KV.put(OPS_REFRESH_KEY, now.toISOString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`OPS_REFRESH_LIMIT_UNWRITABLE ${message}`);
    return textResponse(`the refresh rate limit could not be written (${message}), so no pass was run. Try again shortly.`, 503);
  }

  const actor = adminAgentForEmail(gate.user.email).actor;
  const gather = deps.gather ?? gatherFindings;
  let report: WatcherReport;
  try {
    report = await watcherTick(env, now, () => gather(env, now), { force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`OPS_REFRESH_PASS_FAILED ${message}`);
    await env.DB.batch([auditStatement(env.DB, actor, "portal-ops-refresh", null, null, { ran: false, error: message })]);
    return textResponse(`the watcher pass failed: ${message}`, 500);
  }

  // The click's own audit row, as every Portal action writes one (src/portal-actions.ts).
  let warning: string | null = null;
  try {
    await env.DB.batch([
      auditStatement(env.DB, actor, "portal-ops-refresh", null, null, { ran: report.ran, note: report.note, posted: report.posted, cleared: report.cleared }),
    ]);
  } catch (err) {
    // The pass happened; only its audit row failed. Said in a header and the log, not
    // turned into a failure of a pass that ran.
    warning = `the pass ran, but the Portal audit row naming ${actor} was not written: ${err instanceof Error ? err.message : String(err)}`;
    console.error(warning);
  }
  const feed = await (deps.feed ?? opsFeed)(env, now);
  return feedResponse(request, feed, warning ? { "X-Capsid-Warning": warning.replace(/[^\x20-\x7e]+/g, " ") } : {});
}
