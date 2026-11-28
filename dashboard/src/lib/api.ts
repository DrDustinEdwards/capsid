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
  PortalNamespaces,
  PortalNotFound,
  PortalPerformed,
  PortalPreview,
  PortalSiteSearch,
  PortalSiteTraffic,
  PortalWorkersBuilds,
  PortalBuildLog,
  PortalPush,
  PortalMaintenance,
  PortalConvergence,
  PortalBackups,
  PortalLibrary,
  PortalTrends,
  PortalBoard,
  PortalPrs,
  PortalFigures,
  FigureSet,
  SharedCodeView,
  CompletenessView,
  ResourcesDoc,
} from "../types";

const FEED_URL = `${BASE}/api/ops`;
const REFRESH_URL = `${BASE}/api/ops/refresh`;
const PREVIEW_URL = `${BASE}/api/actions/preview`;
const PERFORM_URL = `${BASE}/api/actions/perform`;
const NAMESPACES_URL = `${BASE}/api/namespaces`;
const ACTIVITY_URL = `${BASE}/api/activity`;
const SHARED_CODE_URL = `${BASE}/api/shared-code`;
const NOT_FOUND_URL = `${BASE}/api/not-found`;
const COMPLETENESS_URL = `${BASE}/api/completeness`;
const RESOURCES_URL = `${BASE}/api/resources`;
const LIBRARY_URL = `${BASE}/api/library`;
const TRENDS_URL = `${BASE}/api/trends`;
const BOARD_URL = `${BASE}/api/board`;
const PRS_URL = `${BASE}/api/prs`;
const FIGURES_URL = `${BASE}/api/figures`;
const SITE_SEARCH_URL = `${BASE}/api/site-search`;
const SITE_TRAFFIC_URL = `${BASE}/api/site-traffic`;
const WORKERS_BUILDS_URL = `${BASE}/api/workers-builds`;
const BUILD_LOG_URL = `${BASE}/api/build-log`;
const MAINTENANCE_URL = `${BASE}/api/maintenance`;
const CONVERGENCE_URL = `${BASE}/api/convergence`;
const BACKUPS_URL = `${BASE}/api/backups`;
const SIGN_OUT_URL = `${BASE}/api/sign-out`;
const PUSH_URL = `${BASE}/api/push`;
export const APP_URL = `${BASE}/`;
export const POLL_MS = 60_000;

async function asFeed(res: Response): Promise<OpsFeed> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new Error(`The feed answered ${res.status} with ${type || "no content type"}, not JSON`);
  return (await res.json()) as OpsFeed;
}

const signedOut = createFlag();

// No retries and no refetch on focus except the feed: a failed read says why at once.
// staleTime above 0 keeps a read the server made fresh on hydration.
export function createQueryClient(): QueryClient {
  return capsomerQueryClient({
    staleTime: 60_000,
    retries: 0,
    refetchOnFocus: false,
    onError: (e) => e instanceof SignedOut && signedOut.set(true),
  });
}

// Never a click, so the feed is marked background: the Worker's idle hour does not count it. The name is site-runtime ./access's BACKGROUND_HEADER, not bundled for one string.
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

export const LIVE = "live";

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
  | { kind: "ok"; feed: OpsFeed; warning: string | null }
  | { kind: "limited"; allowedAt: number | null }
  | { kind: "signed-out" }
  | { kind: "error"; message: string };

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

const noAnswer = (seconds: number) =>
  `no answer within ${seconds} seconds. Check Activity to see whether anything changed before trying again.`;

function post<T>(url: string, csrf: string, body: unknown): Promise<Answer<T>> {
  return postAnswer<T>(url, body, {
    headers: { "X-Capsid-CSRF": csrf },
    timeoutMessage: noAnswer,
  });
}

export function previewAction(
  csrf: string,
  req: PortalActionRequest,
): Promise<Answer<PortalPreview>> {
  return post<PortalPreview>(PREVIEW_URL, csrf, req);
}

export function performAction(csrf: string, token: string): Promise<Answer<PortalPerformed>> {
  return post<PortalPerformed>(PERFORM_URL, csrf, { token });
}

export function fetchNamespaces(): Promise<Answer<PortalNamespaces>> {
  return getAnswer<PortalNamespaces>(NAMESPACES_URL);
}

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

export function fetchSharedCode(): Promise<Answer<SharedCodeView>> {
  return getAnswer<SharedCodeView>(SHARED_CODE_URL);
}

export function fetchNotFound(): Promise<Answer<PortalNotFound>> {
  return getAnswer<PortalNotFound>(NOT_FOUND_URL);
}

export function fetchResources(): Promise<Answer<ResourcesDoc>> {
  return getAnswer<ResourcesDoc>(RESOURCES_URL);
}

export function fetchCompleteness(): Promise<Answer<CompletenessView>> {
  return getAnswer<CompletenessView>(COMPLETENESS_URL);
}

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

export function fetchLibrary(
  args: { q: string } | { ns: string; path: string } | null,
): Promise<Answer<PortalLibrary>> {
  const qs = args ? `?${new URLSearchParams(args).toString()}` : "";
  return getAnswer<PortalLibrary>(`${LIBRARY_URL}${qs}`);
}

export function fetchSiteSearch(namespace: string): Promise<Answer<PortalSiteSearch>> {
  return getAnswer<PortalSiteSearch>(
    `${SITE_SEARCH_URL}?${new URLSearchParams({ namespace }).toString()}`,
  );
}

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

export function fetchBuildLog(build: string): Promise<Answer<PortalBuildLog>> {
  return getAnswer<PortalBuildLog>(`${BUILD_LOG_URL}?${new URLSearchParams({ build }).toString()}`);
}

export function fetchTrends(): Promise<Answer<PortalTrends>> {
  return getAnswer<PortalTrends>(TRENDS_URL);
}

export function fetchBoard(): Promise<Answer<PortalBoard>> {
  return getAnswer<PortalBoard>(BOARD_URL);
}

export function fetchPrs(): Promise<Answer<PortalPrs>> {
  return getAnswer<PortalPrs>(PRS_URL);
}

export function fetchFigures(set: FigureSet): Promise<Answer<PortalFigures>> {
  return getAnswer<PortalFigures>(`${FIGURES_URL}?${new URLSearchParams({ set }).toString()}`);
}

export function fetchMaintenance(): Promise<Answer<PortalMaintenance>> {
  return getAnswer<PortalMaintenance>(MAINTENANCE_URL);
}

export function fetchConvergence(): Promise<Answer<PortalConvergence>> {
  return getAnswer<PortalConvergence>(CONVERGENCE_URL);
}

export function fetchBackups(): Promise<Answer<PortalBackups>> {
  return getAnswer<PortalBackups>(BACKUPS_URL);
}

// A session that already ended counts as signed out; anything else is said, because a silent failure leaves the session open on a shared screen.
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
