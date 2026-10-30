import { QueryCache, QueryClient, keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { BASE } from "./base";
import type { OpsFeed, PortalActionRequest, PortalActivity, PortalClaimsAggregate, PortalClaimsJob, PortalNamespaces, PortalPackageHistory, PortalPerformed, PortalPreview, PortalStale, PortalPush, PortalPlan, PortalDigest, PortalMaintenance, PortalConvergence, PortalLibrary, PortalTrends, SharedCodeView, CompletenessView } from "../types";

// Every URL under the Portal's base on this host (lib/base.ts): /portal/api/... on
// workers.dev, /api/... on portal.dustinedwards.info.
const FEED_URL = `${BASE}/api/ops`;
const REFRESH_URL = `${BASE}/api/ops/refresh`;
const PREVIEW_URL = `${BASE}/api/actions/preview`;
const PERFORM_URL = `${BASE}/api/actions/perform`;
const NAMESPACES_URL = `${BASE}/api/namespaces`;
const ACTIVITY_URL = `${BASE}/api/activity`;
const CLAIMS_URL = `${BASE}/api/claims`;
const PACKAGE_HISTORY_URL = `${BASE}/api/packages/history`;
const SHARED_CODE_URL = `${BASE}/api/shared-code`;
const COMPLETENESS_URL = `${BASE}/api/completeness`;
const LIBRARY_URL = `${BASE}/api/library`;
const TRENDS_URL = `${BASE}/api/trends`;
const STALE_URL = `${BASE}/api/stale`;
const PLAN_URL = `${BASE}/api/plan`;
const DIGEST_URL = `${BASE}/api/digest`;
const MAINTENANCE_URL = `${BASE}/api/maintenance`;
const CONVERGENCE_URL = `${BASE}/api/convergence`;
const SIGN_OUT_URL = `${BASE}/api/sign-out`;
const PUSH_URL = `${BASE}/api/push`;
export const APP_URL = `${BASE}/`;
export const POLL_MS = 60_000;

// The Portal session ended: Access answers with a redirect to its login, or the
// Worker answers 401 or 403. redirect: "manual" keeps a cross-origin login redirect
// from surfacing as an opaque network error. The action endpoints answer 403 for a
// CSRF or cross-site refusal, with its text, so they pass forbidden = false and show
// that text instead of the signed-out page.
function sessionEnded(res: Response, forbidden = true): boolean {
  return res.type === "opaqueredirect" || res.redirected || res.status === 401 || (forbidden && res.status === 403) || (res.status >= 300 && res.status < 400);
}

async function asFeed(res: Response): Promise<OpsFeed> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error(`The feed answered ${res.status} with ${type || "no content type"}, not JSON`);
  return (await res.json()) as OpsFeed;
}

// The session ended: thrown by a read so every query stops the same way, and kept here
// for the app to show the signed-out page. A feed that answers again (a sign-in in
// another tab) clears it.
class SignedOut extends Error {}

let ended = false;
const watchers = new Set<() => void>();
function setSignedOut(next: boolean): void {
  if (ended === next) return;
  ended = next;
  for (const w of watchers) w();
}
function useSignedOut(): boolean {
  return useSyncExternalStore(
    (w) => (watchers.add(w), () => void watchers.delete(w)),
    () => ended,
  );
}

// No retries: a failed read says why at once and the next feed or Read again tries anew.
// Reads go again only when asked (a key, a feed or a button), never on focus, except
// the feed itself.
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (e) => e instanceof SignedOut && setSignedOut(true) }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } },
});

// A route's Answer as a query: its value, or a throw that carries the server's text.
async function ask<T>(read: () => Promise<Answer<T>>): Promise<T> {
  const r = await read();
  if (r.kind === "ok") return r.value;
  if (r.kind === "signed-out") throw new SignedOut("signed out");
  throw new Error(r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message);
}

export type Load<T> = { data: T | null; loading: boolean; error: string | null };

// One Portal route, cached under key. A new key keeps what is on screen and marks it
// loading (keep: false starts it empty); a failed read keeps it too and says why; a
// session that ended signs out (SignedOut). reread reads it again now.
type Read<T> = Load<T> & { reread: () => void };

export function useAnswer<T>(
  key: readonly unknown[],
  read: () => Promise<Answer<T>>,
  { keep = true, staleTime = 0, enabled = true }: { keep?: boolean; staleTime?: number; enabled?: boolean } = {},
): Read<T> {
  const q = useQuery({ queryKey: key, queryFn: () => ask(read), placeholderData: keep ? keepPreviousData : undefined, staleTime, enabled });
  const { refetch } = q;
  return {
    data: q.data ?? null,
    loading: q.isFetching,
    error: q.error && !(q.error instanceof SignedOut) ? q.error.message : null,
    reread: useCallback(() => void refetch(), [refetch]),
  };
}

async function readFeed(): Promise<OpsFeed> {
  const res = await fetch(FEED_URL, { credentials: "same-origin", redirect: "manual", cache: "no-store", headers: { accept: "application/json" } });
  if (sessionEnded(res)) throw new SignedOut("signed out");
  if (!res.ok) throw new Error(`The feed answered ${res.status}`);
  return asFeed(res);
}

const FEED_KEY = ["ops"];

// Reads under this key follow the feed: each new feed reads the shown ones again once
// they are stale (at once for most; a read kept longer says so with its staleTime).
export const LIVE = "live";

// Polls GET /portal/api/ops every 60 s after the last answer while the tab is visible,
// pauses while it is hidden, and reads again when the tab comes back after 5 s or more.
export function useOpsFeed() {
  const q = useQuery({ queryKey: FEED_KEY, queryFn: readFeed, refetchInterval: POLL_MS, staleTime: 5000, refetchOnWindowFocus: true });
  const signedOut = useSignedOut();
  const generated = q.data?.live.generated;
  useEffect(() => {
    if (q.dataUpdatedAt) setSignedOut(false);
  }, [q.dataUpdatedAt]);
  useEffect(() => {
    if (generated)
      void queryClient.refetchQueries({ queryKey: [LIVE], type: "active", stale: true }, { cancelRefetch: false });
  }, [generated]);
  const accept = useCallback((feed: OpsFeed) => queryClient.setQueryData(FEED_KEY, feed), []);
  const signOut = useCallback(() => setSignedOut(true), []);
  return {
    feed: q.data ?? null,
    error: q.error && !(q.error instanceof SignedOut) ? q.error.message : null,
    signedOut,
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
    const res = await fetch(REFRESH_URL, { method: "POST", credentials: "same-origin", redirect: "manual", headers: { "X-Capsid-Ops": "refresh", accept: "application/json" } });
    if (sessionEnded(res)) return { kind: "signed-out" };
    if (res.status === 429) {
      let allowedAt: number | null = null;
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("json")) {
        const body = (await res.json()) as { refresh_allowed_at?: string | null };
        if (body.refresh_allowed_at) allowedAt = Date.parse(body.refresh_allowed_at);
      }
      const retry = Number(res.headers.get("retry-after"));
      if (allowedAt == null && Number.isFinite(retry) && retry > 0) allowedAt = Date.now() + retry * 1000;
      return { kind: "limited", allowedAt };
    }
    if (!res.ok) {
      // The Worker says why in plain text; the status alone is no reason.
      const why = (await res.text().catch(() => "")).trim().slice(0, 300);
      return { kind: "error", message: why ? `${why} (HTTP ${res.status})` : `the server answered HTTP ${res.status}` };
    }
    return { kind: "ok", feed: await asFeed(res), warning: res.headers.get("x-capsid-warning") };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Portal controls, namespaces and activity ----------------------------------------------

// What a control's request came to. A refusal carries the server's text verbatim.
export type Answer<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: number; message: string }
  | { kind: "expired"; message: string }
  | { kind: "signed-out" }
  | { kind: "error"; message: string };

async function refusalText(res: Response): Promise<string> {
  const text = (await res.text()).trim();
  return text || `The server answered ${res.status} with no text`;
}

async function answer<T>(res: Response, forbidden: boolean): Promise<Answer<T>> {
  if (sessionEnded(res, forbidden)) return { kind: "signed-out" };
  if (res.status === 410) return { kind: "expired", message: await refusalText(res) };
  if (!res.ok) return { kind: "refused", status: res.status, message: await refusalText(res) };
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return { kind: "error", message: `The server answered ${res.status} with ${type || "no content type"}, not JSON` };
  return { kind: "ok", value: (await res.json()) as T };
}

// How long a control waits for the Worker before it says so. A request with no answer
// would otherwise leave the dialog busy, with every button disabled and nothing said.
const ACTION_TIMEOUT_MS = 20_000;

async function post<T>(url: string, csrf: string, body: unknown, timeoutMs = ACTION_TIMEOUT_MS): Promise<Answer<T>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      headers: { "X-Capsid-CSRF": csrf, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return await answer<T>(res, false);
  } catch (e) {
    if (abort.signal.aborted) {
      return { kind: "error", message: `no answer within ${Math.round(timeoutMs / 1000)} seconds. Check Activity to see whether anything changed before trying again.` };
    }
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function get<T>(url: string): Promise<Answer<T>> {
  try {
    const res = await fetch(url, { credentials: "same-origin", redirect: "manual", cache: "no-store", headers: { accept: "application/json" } });
    return await answer<T>(res, true);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// POST /portal/api/actions/preview: writes nothing; answers what will change and a token.
export function previewAction(csrf: string, req: PortalActionRequest): Promise<Answer<PortalPreview>> {
  return post<PortalPreview>(PREVIEW_URL, csrf, req);
}

// POST /portal/api/actions/perform: carries only the token; answers the feed after.
export function performAction(csrf: string, token: string): Promise<Answer<PortalPerformed>> {
  return post<PortalPerformed>(PERFORM_URL, csrf, { token });
}

// A switch has no dialog: its applied reason is the confirmation, so it previews and
// performs in sequence. A refusal at either step comes back as it is, to be shown
// beside the switch.
export async function runAction(csrf: string, req: PortalActionRequest): Promise<Answer<PortalPerformed>> {
  const preview = await previewAction(csrf, req);
  if (preview.kind !== "ok") return preview;
  return performAction(csrf, preview.value.token);
}

export function fetchNamespaces(): Promise<Answer<PortalNamespaces>> {
  return get<PortalNamespaces>(NAMESPACES_URL);
}

// GET /portal/api/activity: the newest audit rows, filtered; or, with id, that one row
// for the Activity drawer.
export function fetchActivity(filter: { namespace?: string; actor?: string; id?: string }): Promise<Answer<PortalActivity>> {
  const qs = new URLSearchParams();
  if (filter.id) qs.set("id", filter.id);
  if (filter.namespace) qs.set("namespace", filter.namespace);
  if (filter.actor) qs.set("actor", filter.actor);
  const s = qs.toString();
  return get<PortalActivity>(s ? `${ACTIVITY_URL}?${s}` : ACTIVITY_URL);
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
  for (const key of ["namespace", "agent", "since", "until"] as const) if (filter[key]) qs.set(key, filter[key]);
  const s = qs.toString();
  return get<PortalClaimsAggregate>(s ? `${CLAIMS_URL}?${s}` : CLAIMS_URL);
}

// GET /portal/api/packages/history?name=: one configured package's daily downloads,
// joined to its former name's, and its weekly GitHub numbers. Fetched when asked for.
export function fetchPackageHistory(name: string): Promise<Answer<PortalPackageHistory>> {
  return get<PortalPackageHistory>(`${PACKAGE_HISTORY_URL}?${new URLSearchParams({ name }).toString()}`);
}

// GET /portal/api/shared-code: each shared package's newest tag, what each app pins, and
// the local copies left (src/shared-code.ts), cached by the Worker for an hour.
export function fetchSharedCode(): Promise<Answer<SharedCodeView>> {
  return get<SharedCodeView>(SHARED_CODE_URL);
}

// GET /portal/api/completeness: devkit's daily scoreboard (src/completeness.ts), cached by the
// Worker for ten minutes.
export function fetchCompleteness(): Promise<Answer<CompletenessView>> {
  return get<CompletenessView>(COMPLETENESS_URL);
}

// GET /portal/api/push: the key a browser subscribes with and the devices with phone
// alerts on. POST turns this browser on, a device off, or sends a test (src/push.ts).
export function fetchPush(): Promise<Answer<PortalPush>> {
  return get<PortalPush>(PUSH_URL);
}

export type PushOp = { op: "on"; subscription: PushSubscriptionJSON; label: string } | { op: "off"; id: number } | { op: "test" };

export function postPush(csrf: string, body: PushOp): Promise<Answer<PortalPush>> {
  return post<PortalPush>(PUSH_URL, csrf, body);
}

// GET /portal/api/library: the knowledge store's shelves with no argument, a search with
// q, or one document with ns and path (src/portal-library.ts). Read-only.
export function fetchLibrary(args: { q: string } | { ns: string; path: string } | null): Promise<Answer<PortalLibrary>> {
  const qs = args ? `?${new URLSearchParams(args).toString()}` : "";
  return get<PortalLibrary>(`${LIBRARY_URL}${qs}`);
}

// GET /portal/api/stale: the jobs that look stuck, each with the rule it met and why,
// from the reader behind jobs list stale: true.
export function fetchStale(): Promise<Answer<PortalStale>> {
  return get<PortalStale>(STALE_URL);
}

// GET /portal/api/trends: the series behind the charts the feed does not carry (minutes
// per week, the queue, merges, backup slots, CI by day), from src/trends.ts. Read-only.
export function fetchTrends(): Promise<Answer<PortalTrends>> {
  return get<PortalTrends>(TRENDS_URL);
}

// GET /portal/api/plan: the overnight plan over every namespace, the reader behind jobs
// list view plan.
export function fetchPlan(): Promise<Answer<PortalPlan>> {
  return get<PortalPlan>(PLAN_URL);
}

// GET /portal/api/digest?since=: what finished, blocked and is ready since then, the
// reader behind jobs list view digest.
export function fetchDigest(since: string): Promise<Answer<PortalDigest>> {
  return get<PortalDigest>(`${DIGEST_URL}?since=${encodeURIComponent(since)}`);
}

// GET /portal/api/maintenance: the daily maintenance pass's last list and what it read.
export function fetchMaintenance(): Promise<Answer<PortalMaintenance>> {
  return get<PortalMaintenance>(MAINTENANCE_URL);
}

// GET /portal/api/convergence: each site that opted into its operator API, read live.
export function fetchConvergence(): Promise<Answer<PortalConvergence>> {
  return get<PortalConvergence>(CONVERGENCE_URL);
}

// GET /portal/api/claims?job=<id>: one job's claims, evaluations and touches. A job
// that does not exist is a refusal with status 404.
export function fetchClaimsJob(id: string): Promise<Answer<PortalClaimsJob>> {
  return get<PortalClaimsJob>(`${CLAIMS_URL}?${new URLSearchParams({ job: id }).toString()}`);
}

// POST /portal/api/sign-out: the Worker expires the Portal's cookies and answers 204.
// A session that already ended counts as signed out. Anything else is said, because a
// sign-out that silently failed leaves the session open on a shared screen.
export async function signOutRequest(csrf: string): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
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
    return { kind: "error", message: await refusalText(res) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
