import { readCookie } from "@dustinedwards/site-runtime/headers";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { performControl, previewControl } from "./controls";
import { ACTIVITY_LIMIT, activityFilterFrom, loadActivity } from "./portal-activity";
import {
  endPortalSession,
  logPortalSignOut,
  type PortalUser,
  portalDisplay,
  behindGate,
  portalGate,
  portalSessionId,
  portalSignOutCookies,
  sourceAddress,
} from "./portal-auth";
import { portalCookiePath } from "./portal-host";
import { LOGOUT_HEADERS } from "@dustinedwards/site-runtime/headers";
import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { requireJson } from "@dustinedwards/site-runtime/body";
import type { Env } from "./env";
import { capsidStatus } from "./status";
import { parseReposList } from "./github";
import { readBoundedText } from "./signed-requests";
import { opsFeed, OPS_RETURN_TO, PORTAL_CSRF_COOKIE, type OpsFeedData } from "./ops-feed";
import { isoTime } from "./ops-live";
import type { PortalActivity, PortalNamespaces, PortalPerformed } from "./ops-types/portal";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { warningHeaders } from "./http";
import { jsonResponse, textResponse } from "@dustinedwards/site-runtime/http";
// The Portal's routes for the controls (src/controls.ts holds the controls): the eight actions,
// what each will do, the one dispatch to the shared mutators, and the routes the app calls (the
// contract is the bottom of src/ops-types/).

export const PORTAL_PREVIEW_PATH = "/portal/api/actions/preview";
export const PORTAL_PERFORM_PATH = "/portal/api/actions/perform";
export const PORTAL_NAMESPACES_PATH = "/portal/api/namespaces";
export const PORTAL_ACTIVITY_PATH = "/portal/api/activity";
export const PORTAL_SIGN_OUT_PATH = "/portal/api/sign-out";
// Every Portal data and action route sits under here. A path under it that no route
// names is a JSON 404 (handlePortalApiNotFound), never the app's page.
export const PORTAL_API_PREFIX = "/portal/api/";
// The double-submit CSRF header: the feed's csrf value, compared with the
// capsid_portal_csrf cookie. A cross-site page can neither read the value nor set the
// header without a preflight this Worker does not answer.
export const PORTAL_CSRF_HEADER = "X-Capsid-CSRF";

// Same cap as the consent form, applied at the stream before parsing.
const BODY_MAX_BYTES = 65_536;

// The routes.

type Gated =
  | { ok: true; email: string; user: PortalUser; csrf: string; body: Record<string, unknown> }
  | { ok: false; response: Response };

// The checks both POSTs run, in order: the session, the fetch metadata, the content type, the body
// cap, the CSRF pair, then the JSON. Nothing here reads or writes state.
export async function gateActionRequest(request: Request, env: Env, now: Date): Promise<Gated> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate;

  // A browser names where a request came from (Sec-Fetch-Site, else Origin); another site is refused here.
  // Neither header (an older browser, or curl with the cookies) is let through to the CSRF check.
  const crossSite = refuseCrossSite(request);
  if (crossSite) return { ok: false, response: crossSite };
  // R4: a text/plain or form body is refused before it is read, so no cross-site form or no-cors fetch reaches an
  // action as a simple request (site-runtime ./body requireJson; the signed-in crawl probes it).
  const notJson = requireJson(request);
  if (notJson) return { ok: false, response: notJson };

  const bounded = await readBoundedText(request, BODY_MAX_BYTES);
  if (!bounded.ok)
    return {
      ok: false,
      response: new Response(null, { status: 413, headers: { "Cache-Control": "no-store" } }),
    };

  const header = request.headers.get(PORTAL_CSRF_HEADER);
  const cookie = readCookie(request, PORTAL_CSRF_COOKIE);
  if (!header || !cookie || !(await safeEqual(cookie, header))) {
    return {
      ok: false,
      response: textResponse("csrf validation failed: reload Capsid Portal and try again.", 403),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch (err) {
    return {
      ok: false,
      response: textResponse(`the body is not JSON: ${errorMessage(err)}`, 400),
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: textResponse("the body must be a JSON object.", 400) };
  }
  return {
    ok: true,
    email: gate.user.email,
    user: gate.user,
    csrf: cookie,
    body: body as Record<string, unknown>,
  };
}

// POST /portal/api/actions/preview: what the action will change, and a token to perform it. Writes
// nothing.
export async function handlePortalPreview(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const previewed = await previewControl(
    env,
    gated.email,
    gated.body.action,
    gated.body.params,
    now,
    "portal",
  );
  if (!previewed.ok) return textResponse(previewed.refusal, previewed.status);
  return jsonResponse(previewed.preview);
}

// What the perform can be handed in a test in place of the live feed read.
export interface PortalDeps {
  feed?: (env: Env, now: Date) => Promise<OpsFeedData>;
}

// POST /portal/api/actions/perform: the action a preview signed, run through the shared mutator,
// then the fresh feed.
export async function handlePortalPerform(
  request: Request,
  env: Env,
  now: Date = new Date(),
  deps: PortalDeps = {},
): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const extra = Object.keys(gated.body).filter((key) => key !== "token");
  if (extra.length) {
    return textResponse(
      `a perform carries only { token }: the action and its params come from the signed preview, never from this body. Refused: ${extra.join(", ")}.`,
      400,
    );
  }
  const did = await performControl(
    env,
    gated.email,
    gated.body.token,
    sourceAddress(request),
    now,
    "portal",
  );
  if (!did.ok) return textResponse(did.refusal, did.status);
  const { action, result } = did;

  let data: OpsFeedData;
  try {
    data = await (deps.feed ?? opsFeed)(env, now);
  } catch (err) {
    // The action happened; only the read after it failed. Said as a failure of the
    // read, never as a failure of the action.
    const message = errorMessage(err);
    logEvent(
      "PORTAL_PERFORM_FEED_FAILED",
      { message: `PORTAL_PERFORM_FEED_FAILED ${action}: ${message}` },
      { level: "error" },
    );
    return textResponse(
      `${result.summary} It completed, but reading the feed afterwards failed (${message}). Reload Capsid Portal.`,
      500,
    );
  }
  const performed: PortalPerformed = {
    action,
    summary: result.summary,
    warning: result.warning,
    feed: { ...data, csrf: gated.csrf, user: portalDisplay(gated.user) },
  };
  // A header value must be printable Latin-1; the error text is not guaranteed to be.
  return jsonResponse(performed, 200, warningHeaders(result.warning));
}

// GET /portal/api/namespaces: every roster namespace as capsid_read_status action status reports
// it, from the same function, so the Portal and the tool agree.
export const handlePortalNamespaces = behindGate(async (_request, env, now) => {
  const status = await capsidStatus(env);
  // Each project's repo mapping, so the Projects page can show it and edit it in place.
  const mapped = await env.DB.prepare("SELECT namespace, repos FROM namespaces").all<{
    namespace: string;
    repos: string;
  }>();
  const reposOf = new Map(
    mapped.results.map((r) => {
      const parsed = parseReposList(r.repos);
      return [
        r.namespace,
        "error" in parsed ? [] : parsed.list.map((e) => ({ repo: e.repo, label: e.label })),
      ] as const;
    }),
  );
  const body: PortalNamespaces = {
    generated: now.toISOString(),
    namespaces: status.namespaces.map((ns) => ({
      namespace: ns.namespace,
      latest_report: ns.latest_report
        ? { integrity: ns.latest_report.integrity, generated: ns.latest_report.generated }
        : null,
      repos: reposOf.get(ns.namespace) ?? [],
    })),
  };
  return jsonResponse(body);
});

// GET /portal/api/activity?namespace=&actor=: the last audit rows, filtered. ?id=: that one row,
// for the Activity drawer.
export const handlePortalActivity = behindGate(async (request, env, now) => {
  const parsed = activityFilterFrom(new URL(request.url));
  if (!parsed.ok) return textResponse(parsed.refusal, 400);
  const filter = parsed.filter;
  const rows = await loadActivity(env.DB, filter);
  const body: PortalActivity = {
    generated: now.toISOString(),
    filter,
    rows: rows.map((row) => ({ ...row, at: isoTime(row.at) })),
    limit: ACTIVITY_LIMIT,
  };
  return jsonResponse(body);
});

// POST /portal/api/sign-out, body {}: end this Portal session on the server (endPortalSession, so a
// copied cookie ends too, and other sessions do not) and expire the session and CSRF cookies in
// this browser.
export async function handlePortalSignOut(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const sid = await portalSessionId(request, env);
  if (sid) await endPortalSession(env, sid, now);
  await logPortalSignOut(gated.user.email);
  // Clear-Site-Data too, so the browser drops what the Portal left behind (OSHP's logout headers).
  const headers = new Headers({ "Cache-Control": "no-store", ...LOGOUT_HEADERS });
  for (const cookie of portalSignOutCookies(portalCookiePath(new URL(request.url))))
    headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
}

// Any other path under /portal/api/, any method: behind the gate like every Portal route, then a
// JSON 404, so a typo in the app never reads the app's own page as data.
export const handlePortalApiNotFound = behindGate(async (request) => {
  const path = new URL(request.url).pathname;
  return jsonResponse({ error: `no Portal route at ${request.method} ${path}` }, 404);
});
