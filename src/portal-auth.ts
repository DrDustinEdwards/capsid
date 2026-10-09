import { clearStateCookie, completeAccessLogin, type LoginFlow, startAccessLogin } from "./access-login";
import { getCookie, hmacHex, isAdminEmail, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { isPortalHost, PORTAL_HOST, portalCookiePath, publicPortalPath } from "./portal-host";

// Capsid Portal's own session. The OAuth provider mints tokens for MCP clients, and a
// browser opening /portal has nothing to present, so the Portal signs in through the
// same Access for SaaS app as the MCP login (src/access-login.ts, design PR 3 of
// capsid/research/design-capsid-access-login.md) with its own redirect URL, state
// cookie and KV prefix, and turns the verified email into a signed cookie. It does not
// go through the MCP provider, whose flow ends at a client redirect_uri.
//
// The cookie is a signed assertion (HMAC over a base64url payload with the email and
// an expiry), not a session record. It cannot be revoked before it expires, so the
// TTL is twelve hours and the admin check (ADMIN_EMAIL) runs again on every request.
// Sign out expires it in this browser; a copy taken elsewhere stays valid until it
// expires, which is the cost of a stateless cookie.
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
export const PORTAL_SESSION_TTL_SECONDS = 12 * 60 * 60;

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
  exp: number;
}

export async function portalSessionCookie(user: PortalUser, secret: string, now: Date, cookiePath: string = PORTAL_PATH): Promise<string> {
  const payload: SessionPayload = {
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    exp: Math.floor(now.getTime() / 1000) + PORTAL_SESSION_TTL_SECONDS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(secret, encoded);
  return `${PORTAL_SESSION_COOKIE}=${sig}.${encoded}; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=${PORTAL_SESSION_TTL_SECONDS}`;
}

/** The Set-Cookie values that sign this browser out: the session and CSRF cookies,
 *  same name, path and attributes, Max-Age=0. */
export function portalSignOutCookies(cookiePath: string = PORTAL_PATH): string[] {
  return [
    `${PORTAL_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=0`,
    `${PORTAL_CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=0`,
  ];
}

// The session's user, or null for anything that does not verify. The admin check
// means changing ADMIN_EMAIL invalidates every outstanding Portal cookie.
export async function readPortalSession(request: Request, env: Env, now: Date): Promise<PortalUser | null> {
  const raw = getCookie(request, PORTAL_SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const sig = raw.slice(0, dot);
  const encoded = raw.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmacHex(env.COOKIE_ENCRYPTION_KEY, encoded))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 <= now.getTime()) return null;
  if (!isAdminEmail(env, payload.email)) return null;
  return typeof payload.name === "string" && payload.name ? { email: payload.email, name: payload.name } : { email: payload.email };
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
 *  pass /portalx. */
function isPortalPath(path: string): boolean {
  return path === PORTAL_PATH || path.startsWith(PORTAL_PREFIX);
}

export async function handlePortalCallback(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const flow = portalLogin(url);
  const login = await completeAccessLogin(request, env, flow, (stored) => stored, now);
  if (!login.ok) return login.response;
  const { email, name, state: returnTo } = login;

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
  "forbidden: Capsid Portal admits the administrator's Access session only. An operator key or an agent key authenticates to /ops/mcp, not to this page; the same state is served by the improve_status and jobs tools there. Open the Portal in a browser to sign in as the administrator.";

export type PortalGate = { ok: true; user: PortalUser } | { ok: false; response: Response };

/** Every Portal route but the callback answers to this: a 403 for any Authorization
 *  header, the Access sign-in with no session, else the administrator. */
export async function portalGate(request: Request, env: Env, now: Date, returnTo: string): Promise<PortalGate> {
  if (request.headers.get("Authorization")) {
    return {
      ok: false,
      response: new Response(BEARER_REFUSAL, { status: 403, headers: { "Content-Type": "text/plain;charset=utf-8" } }),
    };
  }
  const user = await readPortalSession(request, env, now);
  if (!user) return { ok: false, response: await startPortalLogin(request, env, returnTo) };
  return { ok: true, user };
}

// The address a Portal request came from, for its audit row (capsid/decisions.md
// 2026-09-30, "admin panels review adopted", item 6). Cloudflare's edge sets
// CF-Connecting-IP on every request and replaces any value a client sends, so it is
// the visitor's address. A value that is not an IPv4 or IPv6 address is recorded as
// null rather than stored as given.
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;
export function sourceAddress(request: Request): string | null {
  const raw = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return ADDRESS.test(raw) && /[.:]/.test(raw) ? raw : null;
}
