import { getCookie, timingSafeEqual } from "./auth";
import { performControl, previewControl } from "./controls";
import { ACTIVITY_LIMIT, activityFilterFrom, loadActivity } from "./portal-activity";
import { type PortalUser, portalDisplay, portalGate, portalSignOutCookies, sourceAddress } from "./portal-auth";
import { portalCookiePath } from "./portal-host";
import type { Env } from "./env";
import { improveStatus } from "./improve-run";
import { readBoundedText } from "./improve-scorer";
import { isoTime, opsFeed, OPS_RETURN_TO, PORTAL_CSRF_COOKIE, type OpsFeedData } from "./ops-feed";
import type { PortalActivity, PortalNamespaces, PortalPerformed } from "./ops-types";
// The Portal's routes for the controls (src/controls.ts holds the controls): the eight actions, what each will do, the one dispatch to the
// shared mutators, and the routes the app calls (the contract is the bottom of
// src/ops-types.ts). They replaced the old /console page's forms, which called this
// same dispatch (capsid/research/design-portal-unify.md), so no transition is
// implemented twice.
//
// No merge (it can start a CI deploy, so it stays behind can_merge) and no mint (a
// mint hands out a key). test/portal-actions.test.ts asserts both absences.
//
// Two requests per action, as ruled 2026-09-11. The preview reads the current state,
// writes nothing, and returns what will change with a signed token that carries the
// action, its params, the administrator's email and a five-minute expiry. The perform
// carries only that token. A replay inside the five minutes is allowed: every
// transition is guarded on the state it moves from, so a second perform is refused by
// the mutator or changes nothing.
//
// Every route answers to portalGate, as the feed does. They are routes, not tools, so
// no grant is checked here (CLAUDE.md, one enforcement point rule); src/scope.ts lists
// them among the routes gated some other way.

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

// ---------------------------------------------------------------------------
// The routes.

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" } });
}

function jsonResponse(body: unknown, extra: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}


type Gated = { ok: true; email: string; user: PortalUser; csrf: string; body: Record<string, unknown> } | { ok: false; response: Response };

/** The checks both POSTs run, in order: the session, the fetch metadata, the body cap,
 *  the CSRF pair, then the JSON. Nothing here reads or writes state. */
async function gateActionRequest(request: Request, env: Env, now: Date): Promise<Gated> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate;

  // A browser names where a request came from. Absent (an older browser, or curl with
  // the cookies) is let through to the CSRF check; any other site is refused here.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") {
    return {
      ok: false,
      response: textResponse(`forbidden: this request came from ${site}, not from Capsid Portal itself (Sec-Fetch-Site: ${site}). Nothing was read or changed.`, 403),
    };
  }

  const bounded = await readBoundedText(request, BODY_MAX_BYTES);
  if (!bounded.ok) return { ok: false, response: new Response(null, { status: 413, headers: { "Cache-Control": "no-store" } }) };

  const header = request.headers.get(PORTAL_CSRF_HEADER);
  const cookie = getCookie(request, PORTAL_CSRF_COOKIE);
  if (!header || !cookie || !timingSafeEqual(cookie, header)) {
    return { ok: false, response: textResponse("csrf validation failed: reload Capsid Portal and try again.", 403) };
  }

  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch (err) {
    return { ok: false, response: textResponse(`the body is not JSON: ${err instanceof Error ? err.message : String(err)}`, 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: textResponse("the body must be a JSON object.", 400) };
  }
  return { ok: true, email: gate.user.email, user: gate.user, csrf: cookie, body: body as Record<string, unknown> };
}


/** POST /portal/api/actions/preview: what the action will change, and a token to
 *  perform it. Writes nothing. */
export async function handlePortalPreview(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const previewed = await previewControl(env, gated.email, gated.body.action, gated.body.params, now, "portal");
  if (!previewed.ok) return textResponse(previewed.refusal, previewed.status);
  return jsonResponse(previewed.preview);
}

// What the perform can be handed in a test in place of the live feed read.
export interface PortalDeps {
  feed?: (env: Env, now: Date) => Promise<OpsFeedData>;
}

/** POST /portal/api/actions/perform: the action a preview signed, run through the
 *  shared mutator, then the fresh feed. */
export async function handlePortalPerform(request: Request, env: Env, now: Date = new Date(), deps: PortalDeps = {}): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const extra = Object.keys(gated.body).filter((key) => key !== "token");
  if (extra.length) {
    return textResponse(
      `a perform carries only { token }: the action and its params come from the signed preview, never from this body. Refused: ${extra.join(", ")}.`,
      400
    );
  }
  const did = await performControl(env, gated.email, gated.body.token, sourceAddress(request), now, "portal");
  if (!did.ok) return textResponse(did.refusal, did.status);
  const { action, result } = did;

  let data: OpsFeedData;
  try {
    data = await (deps.feed ?? opsFeed)(env, now);
  } catch (err) {
    // The action happened; only the read after it failed. Said as a failure of the
    // read, never as a failure of the action.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`PORTAL_PERFORM_FEED_FAILED ${action}: ${message}`);
    return textResponse(`${result.summary} It completed, but reading the feed afterwards failed (${message}). Reload Capsid Portal.`, 500);
  }
  const performed: PortalPerformed = { action, summary: result.summary, warning: result.warning, feed: { ...data, csrf: gated.csrf, user: portalDisplay(gated.user) } };
  // A header value must be printable Latin-1; the error text is not guaranteed to be.
  return jsonResponse(performed, result.warning ? { "X-Capsid-Warning": result.warning.replace(/[^\x20-\x7e]+/g, " ") } : {});
}

/** GET /portal/api/namespaces: every roster namespace as improve_status reports it,
 *  from the same function, so the Portal and the tool agree (ruled 2026-09-11). */
export async function handlePortalNamespaces(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const status = await improveStatus(env);
  const body: PortalNamespaces = {
    generated: now.toISOString(),
    namespaces: status.namespaces.map((ns) => ({
      namespace: ns.namespace,
      paused: ns.paused,
      breaker: { open: ns.breaker.open, failed: ns.breaker.failed, threshold: ns.breaker.threshold, since: ns.breaker.since, reset_at: ns.breaker.reset_at },
      anchor_pinned: ns.anchor_pinned,
      anchor_problem: ns.anchor_problem,
      best: ns.best,
      last_run: ns.last_run
        ? { status: ns.last_run.status, started: ns.last_run.started, attempts: ns.last_run.attempts, kept: ns.last_run.kept, reverts: ns.last_run.reverts }
        : null,
      totals: ns.totals,
      latest_report: ns.latest_report ? { integrity: ns.latest_report.integrity, generated: ns.latest_report.generated } : null,
      jobs: { queued: ns.jobs.queued, claimed: ns.jobs.claimed, blocked: ns.jobs.blocked, done_today: ns.jobs.done_today },
      skills: ns.skills,
    })),
  };
  return jsonResponse(body);
}

/** GET /portal/api/activity?namespace=&actor=: the last audit rows, filtered. ?id=:
 *  that one row, for the Activity drawer. */
export async function handlePortalActivity(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const parsed = activityFilterFrom(new URL(request.url));
  if (!parsed.ok) return new Response(parsed.refusal, { status: 400, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" } });
  const filter = parsed.filter;
  const rows = await loadActivity(env.DB, filter);
  const body: PortalActivity = {
    generated: now.toISOString(),
    filter,
    rows: rows.map((row) => ({ ...row, at: isoTime(row.at) })),
    limit: ACTIVITY_LIMIT,
  };
  return jsonResponse(body);
}

/** POST /portal/api/sign-out, body {}: expire the session and CSRF cookies in this
 *  browser. The same checks as an action (the session, Sec-Fetch-Site, the body cap,
 *  the CSRF pair), so a cross-site page cannot sign the administrator out. It ends the
 *  Portal session only: the Access session at the team domain is Cloudflare's, so the
 *  next visit to /portal may sign in again without a prompt. */
export async function handlePortalSignOut(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of portalSignOutCookies(portalCookiePath(new URL(request.url)))) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
}

/** Any other path under /portal/api/, any method: behind the gate like every Portal
 *  route, then a JSON 404, so a typo in the app never reads the app's own page as data. */
export async function handlePortalApiNotFound(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const path = new URL(request.url).pathname;
  return jsonResponse({ error: `no Portal route at ${request.method} ${path}` }, {}, 404);
}
