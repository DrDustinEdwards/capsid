import { ACCESS_LOGOUT_PATH, ADMIN_IDLE_SECONDS, ADMIN_SEEN_COOKIE, accessIssuer, adminIdle } from "@dustinedwards/site-runtime/access";
import { clearStateCookie, completeAccessLogin, type LoginFlow, startAccessLogin } from "./access-login";
import { cookieName, getCookie, hmacHex, isAdminEmail } from "./auth";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { logEvent, OWASP_EVENTS } from "@dustinedwards/site-runtime/log";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import type { Env } from "./env";
import { isPortalHost, isSameOriginPath, PORTAL_HOST, portalCookiePath, publicPortalPath } from "./portal-host";
import { base64url, fromBase64url } from "@dustinedwards/site-runtime/encoding";
import { isolationVerdict, originRefusal } from "@dustinedwards/site-runtime/origin";

const decodeBase64url = (text: string): string => new TextDecoder().decode(fromBase64url(text));

// Capsid Portal's own session. The OAuth provider mints tokens for MCP clients, and a
// browser opening /portal has nothing to present, so the Portal signs in through the
// same Access for SaaS app as the MCP login (src/access-login.ts, design PR 3 of
// capsid/research/design-capsid-access-login.md) with its own redirect URL, state
// cookie and KV prefix, and turns the verified email into a signed cookie. It does not
// go through the MCP provider, whose flow ends at a client redirect_uri.
//
// The cookie is a signed assertion (HMAC over a base64url payload with the email, a
// random session id, the sign-in time and an expiry). Three things end it:
// - 24 hours after the sign-in (PORTAL_SESSION_TTL_SECONDS), the Portal sends the
//   browser back through Access. 24 hours via Access plus the idle hour below are the
//   approved admin durations (Dustin, 2026-10-31, NIST SP 800-63B-4).
// - An hour with no request: site-runtime's adminIdle times the session, as it times
//   the sites' Access sessions (withPortalIdle below). Past it the Portal session is
//   ended and the browser is sent to Access's logout, which ends the Access session too,
//   so the next visit asks for a sign-in instead of passing straight through.
// - Sign out and the idle end record the session id in D1 (portal_session_ends,
//   migrations/0055), and a cookie carrying it is refused, so a copy taken elsewhere ends
//   too, at once, and the person's other sessions are left alone. Sessions live in D1,
//   never KV (D9).
// The admin check (ADMIN_EMAIL or CO_OWNER_EMAILS) runs again on every request.
//
// Every cookie here is host-only (no Domain attribute, ever) and scoped by portalCookiePath
// (src/portal-host.ts): Path=/ on portal.dustinedwards.info, a host that serves nothing
// but the Portal, and Path=/portal on workers.dev, so /mcp and /ops there never see it. The Portal was at /console until PR B
// of capsid/research/design-portal-unify.md. A Path=/console cookie from then is never
// sent here, so a browser signed in there signs in once more.

export const PORTAL_PATH = "/portal";
export const PORTAL_PREFIX = "/portal/";
export const PORTAL_CALLBACK_PATH = "/portal/callback";

const PORTAL_SESSION_COOKIE = "capsid_portal";
// The double-submit CSRF cookie (OpsFeed.csrf). Minted when absent or malformed and
// then left alone, never rotated per poll, so a preview and its perform carry one
// value (src/ops-feed.ts).
export const PORTAL_CSRF_COOKIE = "capsid_portal_csrf";
export const PORTAL_SESSION_TTL_SECONDS = 24 * 60 * 60;
// The browser keeps the cookie an idle hour past its expiry, so a request after the
// expiry is still timed: an idle one ends the Access session rather than passing a
// silent sign-in.
const PORTAL_COOKIE_MAX_AGE = PORTAL_SESSION_TTL_SECONDS + ADMIN_IDLE_SECONDS;

// The Portal's half of the Access login. The state stored against the token is the
// Portal path to return to. The callback and the state cookie follow the host: on
// portal.dustinedwards.info the callback is /callback, which the host rewrite hands to
// PORTAL_CALLBACK_PATH; Access must list each host's callback URL (docs/auth.md).
function portalLogin(url: URL): LoginFlow {
  return {
    callbackPath: publicPortalPath(url, PORTAL_CALLBACK_PATH),
    stateCookie: "capsid_portal_state",
    cookiePath: portalCookiePath(url),
    kvPrefix: "capsid:portal-state:",
    restartHint: isPortalHost(url) ? `Open https://${PORTAL_HOST} again.` : "Open /portal again.",
  };
}

export interface PortalUser {
  email: string;
  // From the Access ID token's name claim, when the identity provider sent one.
  name?: string;
}

interface SessionPayload extends PortalUser {
  // The session id: random, one per sign-in, what sign-out ends.
  sid: string;
  // The sign-in time, epoch milliseconds.
  at: number;
  exp: number;
}

export async function portalSessionCookie(user: PortalUser, secret: string, now: Date, cookiePath: string = PORTAL_PATH): Promise<string> {
  const payload: SessionPayload = {
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    sid: crypto.randomUUID(),
    at: now.getTime(),
    exp: Math.floor(now.getTime() / 1000) + PORTAL_SESSION_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  const sig = await hmacHex(secret, encoded);
  return `${cookieName(PORTAL_SESSION_COOKIE, cookiePath)}=${sig}.${encoded}; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=${PORTAL_COOKIE_MAX_AGE}`;
}

/** The Set-Cookie values that sign this browser out: the session and CSRF cookies,
 *  same name, path and attributes, Max-Age=0, under the prefixed name and the bare one
 *  they had before (for one release, with getCookie's fallback). */
export function portalSignOutCookies(cookiePath: string = PORTAL_PATH): string[] {
  return [PORTAL_SESSION_COOKIE, PORTAL_CSRF_COOKIE].flatMap((name) =>
    [cookieName(name, cookiePath), name].map((n) => `${n}=; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=0`),
  );
}

// The verified payload, expired or not, or null: a bad signature or shape, an email no
// longer admitted (so changing ADMIN_EMAIL or CO_OWNER_EMAILS invalidates every
// outstanding Portal cookie), or a session that was signed out or ended idle. Read once per request: withPortalIdle and portalGate share it.
const verified = new WeakMap<Request, Promise<SessionPayload | null>>();
function verifiedSession(request: Request, env: Env): Promise<SessionPayload | null> {
  let found = verified.get(request);
  if (!found) {
    found = verifySession(request, env);
    verified.set(request, found);
  }
  return found;
}

async function verifySession(request: Request, env: Env): Promise<SessionPayload | null> {
  const raw = getCookie(request, PORTAL_SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const sig = raw.slice(0, dot);
  const encoded = raw.slice(dot + 1);
  if (!await safeEqual(sig, await hmacHex(env.COOKIE_ENCRYPTION_KEY, encoded))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(decodeBase64url(encoded)) as SessionPayload;
  } catch {
    return null;
  }
  // A cookie from before the session id was kept carries no `sid` and signs in once more.
  if (typeof payload?.email !== "string" || typeof payload.exp !== "number" || typeof payload.at !== "number" || typeof payload.sid !== "string") return null;
  if (!await isAdminEmail(env, payload.email)) return null;
  const ended = await env.DB.prepare("SELECT 1 AS ended FROM portal_session_ends WHERE sid = ?1").bind(payload.sid).first();
  if (ended) return null;
  return payload;
}

// The session's user, or null for anything that does not verify or has expired.
export async function readPortalSession(request: Request, env: Env, now: Date): Promise<PortalUser | null> {
  const payload = await verifiedSession(request, env);
  if (!payload || payload.exp * 1000 <= now.getTime()) return null;
  return typeof payload.name === "string" && payload.name ? { email: payload.email, name: payload.name } : { email: payload.email };
}

/** Ends one Portal session, in any browser that holds its cookie. The row is kept until
 *  the cookie could no longer be sent (the nightly backup prunes it after `expires_at`). */
export async function endPortalSession(env: Env, sid: string, now: Date): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO portal_session_ends (sid, ended_at, expires_at) VALUES (?1, ?2, ?3)")
    .bind(sid, now.getTime(), now.getTime() + PORTAL_COOKIE_MAX_AGE * 1000)
    .run();
}

/** The id of the request's verified session, expired or not, or null. */
export async function portalSessionId(request: Request, env: Env): Promise<string | null> {
  return (await verifiedSession(request, env))?.sid ?? null;
}

// The auth event log names a person by a digest of the address, never the address
// (site-runtime ./log, "The auth event log").
async function emailKey(email: string): Promise<string> {
  return `email:${await sha256Hex(email.trim().toLowerCase())}`;
}

/** The auth event line for a Portal sign-out (POST /portal/api/sign-out). */
export async function logPortalSignOut(email: string): Promise<void> {
  logEvent(OWASP_EVENTS.signOut, { message: "Portal sign-out", app: "portal", email_key: await emailKey(email) });
}

/**
 * site-runtime's adminIdle around the Portal's routes, as the sites use withAdminIdle
 * around /admin. The Portal's sign-in is not an Access token on the request, so it
 * passes adminIdle its own session: `id` a server-keyed digest of the session id, so
 * the last-request cookie cannot be made without COOKIE_ENCRYPTION_KEY, and
 * `signedInAt` the sign-in time. The app's polling fetches send
 * X-Background (BACKGROUND_HEADER), which adminIdle checks but does not count as a
 * request, so an open tab left alone goes idle. With no session it goes straight to
 * `handle`, whose gate starts the sign-in.
 */
export async function withPortalIdle(request: Request, env: Env, handle: () => Promise<Response>, now: Date = new Date()): Promise<Response> {
  const session = await verifiedSession(request, env);
  if (!session) return handle();
  const id = await hmacHex(env.COOKIE_ENCRYPTION_KEY, `portal-idle.${session.sid}`);
  const gate = await adminIdle(request, { session: { id, signedInAt: session.at }, now: now.getTime() });
  if (gate.idle) {
    await endPortalSession(env, session.sid, now);
    logEvent(OWASP_EVENTS.sessionExpired, { message: "Portal session ended after an idle hour", app: "portal", reason: "idle", email_key: await emailKey(session.email) });
    const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
    const url = new URL(request.url);
    const headers = new Headers({ "Cache-Control": "no-store", Location: issuer ? `${issuer}${ACCESS_LOGOUT_PATH}` : publicPortalPath(url, PORTAL_PREFIX) });
    for (const cookie of portalSignOutCookies(portalCookiePath(url))) headers.append("Set-Cookie", cookie);
    headers.append("Set-Cookie", `${ADMIN_SEEN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  }
  const response = await handle();
  if (!gate.cookie) return response;
  const out = new Response(response.body, response);
  out.headers.append("Set-Cookie", gate.cookie);
  return out;
}

/** What the top bar shows for the signed-in person: the name from their Access identity,
 *  else the local part of their email, never a fixed label. Initials are the first letters
 *  of the first and last word. */
export function portalDisplay(user: PortalUser): { name: string; initials: string } {
  const name = user.name?.trim() || user.email.split("@")[0] || user.email;
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const first = Array.from(words[0] ?? name)[0] ?? "?";
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? "")[0] ?? "") : "";
  return { name, initials: (first + last).toUpperCase() };
}

export function startPortalLogin(request: Request, env: Env, returnTo: string): Promise<Response> {
  return startAccessLogin(request, env, portalLogin(new URL(request.url)), returnTo);
}

/** /portal itself or a path under /portal/. A bare startsWith("/portal") would also
 *  pass /portalx, and /portal//host would leave the origin once /portal is cut off. */
function isPortalPath(path: string): boolean {
  if (path === PORTAL_PATH) return true;
  return path.startsWith(PORTAL_PREFIX) && isSameOriginPath(path.slice(PORTAL_PATH.length));
}

export async function handlePortalCallback(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const flow = portalLogin(url);
  const login = await completeAccessLogin(request, env, flow, (stored) => stored, now);
  if (!login.ok) {
    logEvent(OWASP_EVENTS.signInFailure, { message: `Portal sign-in refused: ${login.code}`, app: "portal", via: "access", code: login.code }, { level: "warn" });
    return login.response;
  }
  const { email, name, state: returnTo } = login;
  logEvent(OWASP_EVENTS.signInSuccess, { message: "Portal sign-in", app: "portal", via: "access", email_key: await emailKey(email) });

  // A relative Portal path only, checked rather than trusted from KV, so a bad write
  // cannot become an open redirect.
  // The stored path is internal (/portal/x); the browser on the Portal host goes to /x.
  const safeReturn = isPortalPath(returnTo) ? returnTo : PORTAL_PREFIX;
  const headers = new Headers({ Location: publicPortalPath(url, safeReturn) });
  headers.append("Set-Cookie", await portalSessionCookie(name ? { email, name } : { email }, env.COOKIE_ENCRYPTION_KEY, now, portalCookiePath(url)));
  headers.append("Set-Cookie", clearStateCookie(flow));
  return new Response(null, { status: 302, headers });
}

// A bearer token is refused, not redirected. An agent or operator key presented to
// the Portal is a caller that cannot follow a login redirect: a 302 would send a
// machine to the Access sign-in and look, from its side, like the Portal being down.
// The refusal names what was presented and what the page admits instead.
const BEARER_REFUSAL =
  "forbidden: Capsid Portal admits the administrator's Access session only. An operator key or an agent key authenticates to /ops/mcp, not to this page; the same state is served by capsid_run_improve action status and capsid_work_jobs there. Open the Portal in a browser to sign in as the administrator.";

export type PortalGate = { ok: true; user: PortalUser } | { ok: false; response: Response };

/** Every Portal route but the callback answers to this: a 403 for any Authorization
 *  header, the Access sign-in with no session, else the administrator. */
export async function portalGate(request: Request, env: Env, now: Date, returnTo: string): Promise<PortalGate> {
  if (request.headers.get("Authorization")) {
    logEvent(OWASP_EVENTS.authorizationFailure, { message: "Portal refused a bearer token", app: "portal", reason: "bearer" }, { level: "warn" });
    return {
      ok: false,
      response: new Response(BEARER_REFUSAL, { status: 403, headers: { "Content-Type": "text/plain;charset=utf-8" } }),
    };
  }
  // Resource isolation (site-runtime isolationVerdict, R2): another site may link to a Portal page (a top-level GET
  // navigation) and nothing more, so no page elsewhere loads a signed-in response as an image, script, frame or fetch.
  if (!isolationVerdict(request).ok) return { ok: false, response: originRefusal() };
  const user = await readPortalSession(request, env, now);
  if (!user) return { ok: false, response: await startPortalLogin(request, env, returnTo) };
  return { ok: true, user };
}

// The address a Portal request came from, for its audit row. Cloudflare's edge sets
// CF-Connecting-IP on every request and replaces any value a client sends, so it is
// the visitor's address. A value that is not an IPv4 or IPv6 address is recorded as
// null rather than stored as given.
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;
export function sourceAddress(request: Request): string | null {
  const raw = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return ADDRESS.test(raw) && /[.:]/.test(raw) ? raw : null;
}
