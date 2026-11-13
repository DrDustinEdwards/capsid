import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SignedOut,
  createFlag,
  createQueryClient as capsomerQueryClient,
  getAnswer,
  postAnswer,
  sessionEnded,
  useFlag,
  type Answer,
} from "capsomer/react/data";
import { useCallback, useEffect } from "react";
import { BASE } from "./base";
import type {
  OpsFeed,
  PortalActionRequest,
  PortalActivity,
  PortalClaimsAggregate,
  PortalClaimsJob,
  PortalNamespaces,
  PortalNotFound,
  PortalPackageHistory,
  PortalPerformed,
  PortalPreview,
  PortalStale,
  PortalMergeUnits,
  PortalSiteSearch,
  PortalSiteTraffic,
  PortalWorkersBuilds,
  PortalBuildLog,
  PortalPush,
  PortalPlan,
  PortalDigest,
  PortalMaintenance,
  PortalConvergence,
  PortalBackups,
  PortalLibrary,
  PortalTrends,
  SharedCodeView,
  CompletenessView,
  ResourcesDoc,
} from "../types";

// Every URL under the Portal's base on this page (lib/base.ts): /api/... on
// portal.dustinedwards.info, /demos/api/... on the chart demo.
const FEED_URL = `${BASE}/api/ops`;
const REFRESH_URL = `${BASE}/api/ops/refresh`;
const PREVIEW_URL = `${BASE}/api/actions/preview`;
const PERFORM_URL = `${BASE}/api/actions/perform`;
const NAMESPACES_URL = `${BASE}/api/namespaces`;
const ACTIVITY_URL = `${BASE}/api/activity`;
const CLAIMS_URL = `${BASE}/api/claims`;
const PACKAGE_HISTORY_URL = `${BASE}/api/packages/history`;
const SHARED_CODE_URL = `${BASE}/api/shared-code`;
const NOT_FOUND_URL = `${BASE}/api/not-found`;
const COMPLETENESS_URL = `${BASE}/api/completeness`;
const RESOURCES_URL = `${BASE}/api/resources`;
const LIBRARY_URL = `${BASE}/api/library`;
const TRENDS_URL = `${BASE}/api/trends`;
const STALE_URL = `${BASE}/api/stale`;
const MERGE_UNITS_URL = `${BASE}/api/merge-units`;
const SITE_SEARCH_URL = `${BASE}/api/site-search`;
const SITE_TRAFFIC_URL = `${BASE}/api/site-traffic`;
const WORKERS_BUILDS_URL = `${BASE}/api/workers-builds`;
const BUILD_LOG_URL = `${BASE}/api/build-log`;
const PLAN_URL = `${BASE}/api/plan`;
const DIGEST_URL = `${BASE}/api/digest`;
const MAINTENANCE_URL = `${BASE}/api/maintenance`;
const CONVERGENCE_URL = `${BASE}/api/convergence`;
const BACKUPS_URL = `${BASE}/api/backups`;
const SIGN_OUT_URL = `${BASE}/api/sign-out`;
const PUSH_URL = `${BASE}/api/push`;
export const APP_URL = `${BASE}/`;
export const POLL_MS = 60_000;

// Capsomer's data layer (capsomer/react/data) holds what a request came to (Answer), the session
// test, the reads and posts, the signed-out flag and the Answer query hook. This file keeps the
// Portal's own routes, the feed and its words. The re-exports are for the views that import them here.
export { useAnswer, type Answer, type Load } from "capsomer/react/data";

async function asFeed(res: Response): Promise<OpsFeed> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new Error(`The feed answered ${res.status} with ${type || "no content type"}, not JSON`);
  return (await res.json()) as OpsFeed;
}

// The session ended: kept here for the app to show the signed-out page. A feed that answers again
// (a sign-in in another tab) clears it.
const signedOut = createFlag();

// No retries: a failed read says why at once and the next feed or Read again tries anew.
// Reads go again only when asked (a key, a feed or a button), never on focus, except
// the feed itself. One client per page load in the browser and one per request on the
// server (root.tsx, server/prefetch.ts), so no request shares a cache with another
// (TanStack Query, Advanced Server Rendering). staleTime above 0: a read the server made for
// this page is fresh on hydration; the feed's minute poll, Read again and every action's
// invalidation read again whatever the age.
export function createQueryClient(): QueryClient {
  return capsomerQueryClient({
    staleTime: 60_000,
    retries: 0,
    refetchOnFocus: false,
    onError: (e) => e instanceof SignedOut && signedOut.set(true),
  });
}

// The feed is read only by the page itself (on load, the minute poll and a return to
// the tab), never by a click, so it is marked background: the Worker's idle hour
// (withPortalIdle) checks it but does not count it, and an open tab left alone signs
// out. The name is site-runtime ./access's BACKGROUND_HEADER; the app does not bundle
// the server package for one string.
const BACKGROUND = { "X-Background": "1" } as const;

async function readFeed(): Promise<OpsFeed> {
  const res = await fetch(FEED_URL, {
    credentials: "same-origin",
    redirect: "manual",
    cache: "no-store",
    headers: { accept: "application/json", ...BACKGROUND },
  });
  if (sessionEnded(res)) throw new SignedOut();
  if (!res.ok) throw new Error(`The feed answered ${res.status}`);
  return asFeed(res);
}

export const FEED_KEY = ["ops"];

// Reads under this key follow the feed: each new feed reads the shown ones again once
// they are stale (at once for most; a read kept longer says so with its staleTime).
export const LIVE = "live";

// Polls GET /portal/api/ops every 60 s after the last answer while the tab is visible,
// pauses while it is hidden, and reads again when the tab comes back after 5 s or more.
export function useOpsFeed() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: FEED_KEY,
    queryFn: readFeed,
    refetchInterval: POLL_MS,
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });
  const isSignedOut = useFlag(signedOut);
  const generated = q.data?.live.generated;
  useEffect(() => {
    if (q.dataUpdatedAt) signedOut.set(false);
  }, [q.dataUpdatedAt]);
  useEffect(() => {
    if (generated)
      void queryClient.refetchQueries(
        { queryKey: [LIVE], type: "active", stale: true },
        { cancelRefetch: false },
      );
  }, [generated, queryClient]);
  const accept = useCallback(
    (feed: OpsFeed) => queryClient.setQueryData(FEED_KEY, feed),
    [queryClient],
  );
  const signOut = useCallback(() => signedOut.set(true), []);
  return {
    feed: q.data ?? null,
    error: q.error && !(q.error instanceof SignedOut) ? q.error.message : null,
    signedOut: isSignedOut,
    nextPollAt: Math.max(q.dataUpdatedAt, q.errorUpdatedAt) + POLL_MS,
    accept,
    signOut,
  };
}

export type RefreshResult =
  // warning: the pass ran but its audit row naming you was not written (the Worker's
  // X-Capsid-Warning header, src/ops-feed.ts).
  | { kind: "ok"; feed: OpsFeed; warning: string | null }
  | { kind: "limited"; allowedAt: number | null }
  | { kind: "signed-out" }
  | { kind: "error"; message: string };

// POST /portal/api/ops/refresh runs a watcher pass now and answers the new feed. A
// 429 says when the next is allowed: refresh_allowed_at in the body when it is JSON,
// else Retry-After.
export async function requestRefresh(): Promise<RefreshResult> {
  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      headers: { "X-Capsid-Ops": "refresh", accept: "application/json" },
    });
    if (sessionEnded(res)) return { kind: "signed-out" };
    if (res.status === 429) {
      let allowedAt: number | null = null;
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("json")) {
        const body = (await res.json()) as { refresh_allowed_at?: string | null };
        if (body.refresh_allowed_at) allowedAt = Date.parse(body.refresh_allowed_at);
      }
      const retry = Number(res.headers.get("retry-after"));
      if (allowedAt == null && Number.isFinite(retry) && retry > 0)
        allowedAt = Date.now() + retry * 1000;
      return { kind: "limited", allowedAt };
    }
    if (!res.ok) {
      // The Worker says why in plain text; the status alone is no reason.
      const why = (await res.text().catch(() => "")).trim().slice(0, 300);
      return {
        kind: "error",
        message: why ? `${why} (HTTP ${res.status})` : `the server answered HTTP ${res.status}`,
      };
    }
    return { kind: "ok", feed: await asFeed(res), warning: res.headers.get("x-capsid-warning") };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Portal controls, namespaces and activity ----------------------------------------------

// Capsid's words for an action with no answer in time: Activity says whether it went through.
const noAnswer = (seconds: number) =>
  `no answer within ${seconds} seconds. Check Activity to see whether anything changed before trying again.`;

// A Portal action: the CSRF header on every post, and Capsomer's 20 s wait with Capsid's words.
function post<T>(url: string, csrf: string, body: unknown): Promise<Answer<T>> {
  return postAnswer<T>(url, body, {
    headers: { "X-Capsid-CSRF": csrf },
    timeoutMessage: noAnswer,
  });
}

// POST /portal/api/actions/preview: writes nothing; answers what will change and a token.
export function previewAction(
  csrf: string,
  req: PortalActionRequest,
): Promise<Answer<PortalPreview>> {
  return post<PortalPreview>(PREVIEW_URL, csrf, req);
}

// POST /portal/api/actions/perform: carries only the token; answers the feed after.
export function performAction(csrf: string, token: string): Promise<Answer<PortalPerformed>> {
  return post<PortalPerformed>(PERFORM_URL, csrf, { token });
}

// A switch has no dialog: its applied reason is the confirmation, so it previews and
// performs in sequence. A refusal at either step comes back as it is, to be shown
// beside the switch.
export async function runAction(
  csrf: string,
  req: PortalActionRequest,
): Promise<Answer<PortalPerformed>> {
  const preview = await previewAction(csrf, req);
  if (preview.kind !== "ok") return preview;
  return performAction(csrf, preview.value.token);
}

export function fetchNamespaces(): Promise<Answer<PortalNamespaces>> {
  return getAnswer<PortalNamespaces>(NAMESPACES_URL);
}

// GET /portal/api/activity: the newest audit rows, filtered; or, with id, that one row
// for the Activity drawer.
export function fetchActivity(filter: {
  namespace?: string;
  actor?: string;
  id?: string;
}): Promise<Answer<PortalActivity>> {
  const qs = new URLSearchParams();
  if (filter.id) qs.set("id", filter.id);
  if (filter.namespace) qs.set("namespace", filter.namespace);
  if (filter.actor) qs.set("actor", filter.actor);
  const s = qs.toString();
  return getAnswer<PortalActivity>(s ? `${ACTIVITY_URL}?${s}` : ACTIVITY_URL);
}

export interface ClaimsQuery {
  namespace: string;
  agent: string;
  since: string;
  until: string;
}

// GET /portal/api/claims: the per-agent aggregate, filtered.
export function fetchClaimsAggregate(filter: ClaimsQuery): Promise<Answer<PortalClaimsAggregate>> {
  const qs = new URLSearchParams();
  for (const key of ["namespace", "agent", "since", "until"] as const)
    if (filter[key]) qs.set(key, filter[key]);
  const s = qs.toString();
  return getAnswer<PortalClaimsAggregate>(s ? `${CLAIMS_URL}?${s}` : CLAIMS_URL);
}

// GET /portal/api/packages/history?name=: one configured package's daily downloads,
// joined to its former name's, and its weekly GitHub numbers. Fetched when asked for.
export function fetchPackageHistory(name: string): Promise<Answer<PortalPackageHistory>> {
  return getAnswer<PortalPackageHistory>(
    `${PACKAGE_HISTORY_URL}?${new URLSearchParams({ name }).toString()}`,
  );
}

// GET /portal/api/shared-code: each shared package's newest tag, what each app pins, and
// the local copies left (src/shared-code.ts), cached by the Worker for an hour.
export function fetchSharedCode(): Promise<Answer<SharedCodeView>> {
  return getAnswer<SharedCodeView>(SHARED_CODE_URL);
}

// GET /portal/api/not-found: Capsid's own missing pages over 30 days (page_404_daily).
export function fetchNotFound(): Promise<Answer<PortalNotFound>> {
  return getAnswer<PortalNotFound>(NOT_FOUND_URL);
}

// GET /portal/api/resources: the secrets and data model the nightly build read from
// Cloudflare (src/system-resources.ts): names, never values.
export function fetchResources(): Promise<Answer<ResourcesDoc>> {
  return getAnswer<ResourcesDoc>(RESOURCES_URL);
}

// GET /portal/api/completeness: devkit's daily scoreboard (src/completeness.ts), cached by the
// Worker for ten minutes.
export function fetchCompleteness(): Promise<Answer<CompletenessView>> {
  return getAnswer<CompletenessView>(COMPLETENESS_URL);
}

// GET /portal/api/push: the key a browser subscribes with and the devices with phone
// alerts on. POST turns this browser on, a device off, or sends a test (src/push.ts).
export function fetchPush(): Promise<Answer<PortalPush>> {
  return getAnswer<PortalPush>(PUSH_URL);
}

export type PushOp =
  | { op: "on"; subscription: PushSubscriptionJSON; label: string }
  | { op: "off"; id: number }
  | { op: "test" };

export function postPush(csrf: string, body: PushOp): Promise<Answer<PortalPush>> {
  return post<PortalPush>(PUSH_URL, csrf, body);
}

// GET /portal/api/library: the knowledge store's shelves with no argument, a search with
// q, or one document with ns and path (src/portal-library.ts). Read-only.
export function fetchLibrary(
  args: { q: string } | { ns: string; path: string } | null,
): Promise<Answer<PortalLibrary>> {
  const qs = args ? `?${new URLSearchParams(args).toString()}` : "";
  return getAnswer<PortalLibrary>(`${LIBRARY_URL}${qs}`);
}

// GET /portal/api/stale: the jobs that look stuck, each with the rule it met and why,
// from the reader behind jobs list stale: true.
export function fetchStale(): Promise<Answer<PortalStale>> {
  return getAnswer<PortalStale>(STALE_URL);
}

// GET /portal/api/merge-units: the suspended merge units and the units tick's proposals
// (src/portal-merge-units.ts), for the Pull requests page's Merge units panel.
export function fetchMergeUnits(): Promise<Answer<PortalMergeUnits>> {
  return getAnswer<PortalMergeUnits>(MERGE_UNITS_URL);
}

// The site page's reads (src/portal-site.ts), each live for one namespace. Every source in
// them is its data or no data with the reason (SiteSource), never a zero.

// GET /portal/api/site-search?namespace=: Search Console and Bing Webmaster, the 28 days
// ending 3 days ago.
export function fetchSiteSearch(namespace: string): Promise<Answer<PortalSiteSearch>> {
  return getAnswer<PortalSiteSearch>(
    `${SITE_SEARCH_URL}?${new URLSearchParams({ namespace }).toString()}`,
  );
}

// GET /portal/api/site-traffic?namespace=&days=: 404s, 5xx, web vitals and AI crawlers from
// Cloudflare over the last `days` (1 to 30; the Worker's default is 7).
export function fetchSiteTraffic(
  namespace: string,
  days?: number,
): Promise<Answer<PortalSiteTraffic>> {
  const q = new URLSearchParams({
    namespace,
    ...(days === undefined ? {} : { days: String(days) }),
  });
  return getAnswer<PortalSiteTraffic>(`${SITE_TRAFFIC_URL}?${q.toString()}`);
}

// GET /portal/api/workers-builds?namespace=&limit=: the Workers Builds of the Worker the
// site row names, newest first (1 to 50; the Worker's default is 10).
export function fetchWorkersBuilds(
  namespace: string,
  limit?: number,
): Promise<Answer<PortalWorkersBuilds>> {
  const q = new URLSearchParams({
    namespace,
    ...(limit === undefined ? {} : { limit: String(limit) }),
  });
  return getAnswer<PortalWorkersBuilds>(`${WORKERS_BUILDS_URL}?${q.toString()}`);
}

// GET /portal/api/build-log?build=<uuid>: one build's log, its last 500 lines.
export function fetchBuildLog(build: string): Promise<Answer<PortalBuildLog>> {
  return getAnswer<PortalBuildLog>(`${BUILD_LOG_URL}?${new URLSearchParams({ build }).toString()}`);
}

// GET /portal/api/trends: the series behind the charts the feed does not carry (minutes
// per week, the queue, merges, backup slots, CI by day), from src/trends.ts. Read-only.
export function fetchTrends(): Promise<Answer<PortalTrends>> {
  return getAnswer<PortalTrends>(TRENDS_URL);
}

// GET /portal/api/plan: the overnight plan over every namespace, the reader behind jobs
// list view plan.
export function fetchPlan(): Promise<Answer<PortalPlan>> {
  return getAnswer<PortalPlan>(PLAN_URL);
}

// GET /portal/api/digest?since=: what finished, blocked and is ready since then, the
// reader behind jobs list view digest.
export function fetchDigest(since: string): Promise<Answer<PortalDigest>> {
  return getAnswer<PortalDigest>(`${DIGEST_URL}?since=${encodeURIComponent(since)}`);
}

// GET /portal/api/maintenance: the daily maintenance pass's last list and what it read.
export function fetchMaintenance(): Promise<Answer<PortalMaintenance>> {
  return getAnswer<PortalMaintenance>(MAINTENANCE_URL);
}

// GET /portal/api/convergence: each site that opted into its operator API, read live.
export function fetchConvergence(): Promise<Answer<PortalConvergence>> {
  return getAnswer<PortalConvergence>(CONVERGENCE_URL);
}

// GET /portal/api/backups: every site's backup_status read live, beside its Amazon copy.
export function fetchBackups(): Promise<Answer<PortalBackups>> {
  return getAnswer<PortalBackups>(BACKUPS_URL);
}

// GET /portal/api/claims?job=<id>: one job's claims, evaluations and touches. A job
// that does not exist is a refusal with status 404.
export function fetchClaimsJob(id: string): Promise<Answer<PortalClaimsJob>> {
  return getAnswer<PortalClaimsJob>(`${CLAIMS_URL}?${new URLSearchParams({ job: id }).toString()}`);
}

// POST /portal/api/sign-out: the Worker expires the Portal's cookies and answers 204.
// A session that already ended counts as signed out. Anything else is said, because a
// sign-out that silently failed leaves the session open on a shared screen.
export async function signOutRequest(
  csrf: string,
): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
  try {
    const res = await fetch(SIGN_OUT_URL, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      headers: { "X-Capsid-CSRF": csrf, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status === 204 || sessionEnded(res, false)) return { kind: "ok" };
    const text = (await res.text().catch(() => "")).trim();
    return { kind: "error", message: text || `The server answered ${res.status} with no text` };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
