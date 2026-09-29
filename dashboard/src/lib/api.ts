import { useCallback, useEffect, useRef, useState } from "react";
import type { OpsFeed, PortalActionRequest, PortalActivity, PortalNamespaces, PortalPerformed, PortalPreview } from "../types";

export const FEED_URL = "/console/api/ops";
export const REFRESH_URL = "/console/api/ops/refresh";
export const PREVIEW_URL = "/console/api/actions/preview";
export const PERFORM_URL = "/console/api/actions/perform";
export const NAMESPACES_URL = "/console/api/namespaces";
export const ACTIVITY_URL = "/console/api/activity";
export const APP_URL = "/console/app/";
export const POLL_MS = 60_000;

// The console session ended: Access answers with a redirect to its login, or the
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

export interface FeedState {
  feed: OpsFeed | null;
  error: string | null;
  signedOut: boolean;
  nextPollAt: number;
}

// Polls GET /console/api/ops every 60 s while the tab is visible, pauses while it is
// hidden, and reads again when the tab comes back or the window takes focus.
export function useOpsFeed() {
  const [state, setState] = useState<FeedState>({ feed: null, error: null, signedOut: false, nextPollAt: Date.now() + POLL_MS });
  const last = useRef(0);
  const load = useCallback(async () => {
    last.current = Date.now();
    try {
      const res = await fetch(FEED_URL, { credentials: "same-origin", redirect: "manual", cache: "no-store", headers: { accept: "application/json" } });
      if (sessionEnded(res)) return setState((s) => ({ ...s, signedOut: true }));
      if (!res.ok) throw new Error(`The feed answered ${res.status}`);
      const feed = await asFeed(res);
      setState({ feed, error: null, signedOut: false, nextPollAt: Date.now() + POLL_MS });
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), nextPollAt: Date.now() + POLL_MS }));
    }
  }, []);
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => visible() && Date.now() - last.current >= POLL_MS && void load(), 1000);
    const back = () => visible() && Date.now() - last.current > 5000 && void load();
    void load();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => (clearInterval(timer), document.removeEventListener("visibilitychange", back), window.removeEventListener("focus", back));
  }, [load]);
  const accept = useCallback((feed: OpsFeed) => {
    last.current = Date.now();
    setState({ feed, error: null, signedOut: false, nextPollAt: Date.now() + POLL_MS });
  }, []);
  const signOut = useCallback(() => setState((s) => ({ ...s, signedOut: true })), []);
  return { ...state, reload: load, accept, signOut };
}

export type RefreshResult =
  | { kind: "ok"; feed: OpsFeed }
  | { kind: "limited"; allowedAt: number | null }
  | { kind: "signed-out" }
  | { kind: "error"; message: string };

// POST /console/api/ops/refresh runs a watcher pass now and answers the new feed. A
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
    if (!res.ok) return { kind: "error", message: `Refresh answered ${res.status}` };
    return { kind: "ok", feed: await asFeed(res) };
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
export const ACTION_TIMEOUT_MS = 20_000;

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

// POST /console/api/actions/preview: writes nothing; answers what will change and a token.
export function previewAction(csrf: string, req: PortalActionRequest): Promise<Answer<PortalPreview>> {
  return post<PortalPreview>(PREVIEW_URL, csrf, req);
}

// POST /console/api/actions/perform: carries only the token; answers the feed after.
export function performAction(csrf: string, token: string): Promise<Answer<PortalPerformed>> {
  return post<PortalPerformed>(PERFORM_URL, csrf, { token });
}

export function fetchNamespaces(): Promise<Answer<PortalNamespaces>> {
  return get<PortalNamespaces>(NAMESPACES_URL);
}

export function fetchActivity(filter: { namespace: string; actor: string }): Promise<Answer<PortalActivity>> {
  const qs = new URLSearchParams();
  if (filter.namespace) qs.set("namespace", filter.namespace);
  if (filter.actor) qs.set("actor", filter.actor);
  const s = qs.toString();
  return get<PortalActivity>(s ? `${ACTIVITY_URL}?${s}` : ACTIVITY_URL);
}
