import {
  ACCESS_LOGOUT_PATH,
  ADMIN_IDLE_SECONDS,
  ADMIN_SEEN_COOKIE,
  accessIssuer,
  adminIdle,
} from "@dustinedwards/site-runtime/access";
import {
  clearStateCookie,
  completeAccessLogin,
  type LoginFlow,
  startAccessLogin,
} from "./access-login";
import { isAdminEmail } from "@dustinedwards/site-runtime/access";
import { capsidCookie, confirmKeys } from "./auth";
import { readCookie } from "@dustinedwards/site-runtime/headers";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { logEvent, OWASP_EVENTS } from "@dustinedwards/site-runtime/log";
import { emailKey } from "@dustinedwards/site-runtime/rate-limit";
import type { Env } from "./env";
import { isPortalHost, PORTAL_HOST, portalCookiePath, publicPortalPath } from "./portal-host";
import { base64url, fromBase64urlText, hmacSha256Hex } from "@dustinedwards/site-runtime/encoding";
import { isSameOriginPath } from "@dustinedwards/site-runtime/url";
import { isolationVerdict, originRefusal } from "@dustinedwards/site-runtime/origin";

export const PORTAL_PATH = "/portal";
export const PORTAL_PREFIX = "/portal/";
export const PORTAL_CALLBACK_PATH = "/portal/callback";

const PORTAL_SESSION_COOKIE = "capsid_portal";
// Minted when absent or malformed, then left alone: never rotated per poll, so a preview and its
// perform carry one value (src/ops-feed.ts).
export const PORTAL_CSRF_COOKIE = "capsid_portal_csrf";
export const PORTAL_SESSION_TTL_SECONDS = 24 * 60 * 60;
// The browser keeps the cookie an idle hour past its expiry, so a request after expiry is still
// timed and an idle one ends the Access session rather than passing a silent sign-in.
const PORTAL_COOKIE_MAX_AGE = PORTAL_SESSION_TTL_SECONDS + ADMIN_IDLE_SECONDS;

// The state stored against the token is the Portal path to return to. On portal.dustinedwards.info
// the callback is /callback, which the host rewrite hands to PORTAL_CALLBACK_PATH.
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
  name?: string;
}

interface SessionPayload extends PortalUser {
  sid: string;
  at: number;
  exp: number;
}

// COOKIE_ENCRYPTION_KEY under its own label (confirmKeys), so the root secret signs nothing itself; a
// new label signs every Portal session out once.
const SESSION_LABEL = "portal-session";
const sessionKey = async (secret: string): Promise<string> =>
  (await confirmKeys({ COOKIE_ENCRYPTION_KEY: secret }, SESSION_LABEL))[0];

export async function portalSessionCookie(
  user: PortalUser,
  secret: string,
  now: Date,
  cookiePath: string = PORTAL_PATH,
): Promise<string> {
  const payload: SessionPayload = {
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    sid: crypto.randomUUID(),
    at: now.getTime(),
    exp: Math.floor(now.getTime() / 1000) + PORTAL_SESSION_TTL_SECONDS,
  };
  const encoded = base64url(JSON.stringify(payload));
  const sig = await hmacSha256Hex(await sessionKey(secret), encoded);
  return capsidCookie(
    PORTAL_SESSION_COOKIE,
    `${sig}.${encoded}`,
    cookiePath,
    PORTAL_COOKIE_MAX_AGE,
  );
}

export function portalSignOutCookies(cookiePath: string = PORTAL_PATH): string[] {
  return [PORTAL_SESSION_COOKIE, PORTAL_CSRF_COOKIE].map((name) =>
    capsidCookie(name, "", cookiePath, 0),
  );
}

// Null for a bad signature or shape, an email no longer admitted (so changing ADMIN_EMAIL or
// CO_OWNER_EMAILS invalidates every cookie), or a session signed out or ended idle.
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
  const raw = readCookie(request, PORTAL_SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const sig = raw.slice(0, dot);
  const encoded = raw.slice(dot + 1);
  const key = await sessionKey(env.COOKIE_ENCRYPTION_KEY);
  if (!(await safeEqual(sig, await hmacSha256Hex(key, encoded)))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64urlText(encoded)) as SessionPayload;
  } catch {
    return null;
  }
  // A cookie from before the session id was kept carries no `sid` and signs in once more.
  if (
    typeof payload?.email !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.at !== "number" ||
    typeof payload.sid !== "string"
  )
    return null;
  if (!isAdminEmail(env, payload.email)) return null;
  const ended = await env.DB.prepare("SELECT 1 AS ended FROM portal_session_ends WHERE sid = ?1")
    .bind(payload.sid)
    .first();
  if (ended) return null;
  return payload;
}

export async function readPortalSession(
  request: Request,
  env: Env,
  now: Date,
): Promise<PortalUser | null> {
  const payload = await verifiedSession(request, env);
  if (!payload || payload.exp * 1000 <= now.getTime()) return null;
  return typeof payload.name === "string" && payload.name
    ? { email: payload.email, name: payload.name }
    : { email: payload.email };
}

// Ends one Portal session, in any browser that holds its cookie. The row is kept until the cookie
// could no longer be sent (the nightly backup prunes it after `expires_at`).
export async function endPortalSession(env: Env, sid: string, now: Date): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO portal_session_ends (sid, ended_at, expires_at) VALUES (?1, ?2, ?3)",
  )
    .bind(sid, now.getTime(), now.getTime() + PORTAL_COOKIE_MAX_AGE * 1000)
    .run();
}

export async function portalSessionId(request: Request, env: Env): Promise<string | null> {
  return (await verifiedSession(request, env))?.sid ?? null;
}

export async function logPortalSignOut(email: string): Promise<void> {
  logEvent(OWASP_EVENTS.signOut, {
    message: "Portal sign-out",
    app: "portal",
    email_key: await emailKey("email", email),
  });
}

// The Portal's sign-in is not an Access token on the request, so it passes adminIdle its own session.
export async function withPortalIdle(
  request: Request,
  env: Env,
  handle: () => Promise<Response>,
  now: Date = new Date(),
): Promise<Response> {
  const session = await verifiedSession(request, env);
  if (!session) return handle();
  const id = await hmacSha256Hex(env.COOKIE_ENCRYPTION_KEY, `portal-idle.${session.sid}`);
  // The seen cookie's key, derived from COOKIE_ENCRYPTION_KEY under its own label (HMAC as the
  // KDF, NIST SP 800-108r1), so the Portal needs no second secret and one key does not serve two uses.
  const secret = await hmacSha256Hex(env.COOKIE_ENCRYPTION_KEY, "admin-idle-secret");
  const gate = await adminIdle(request, {
    session: { id, signedInAt: session.at },
    now: now.getTime(),
    secret,
  });
  if (gate.idle) {
    await endPortalSession(env, session.sid, now);
    logEvent(OWASP_EVENTS.sessionExpired, {
      message: "Portal session ended after an idle hour",
      app: "portal",
      reason: "idle",
      email_key: await emailKey("email", session.email),
    });
    const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
    const url = new URL(request.url);
    const headers = new Headers({
      "Cache-Control": "no-store",
      Location: issuer ? `${issuer}${ACCESS_LOGOUT_PATH}` : publicPortalPath(url, PORTAL_PREFIX),
    });
    for (const cookie of portalSignOutCookies(portalCookiePath(url)))
      headers.append("Set-Cookie", cookie);
    headers.append(
      "Set-Cookie",
      `${ADMIN_SEEN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    );
    return new Response(null, { status: 302, headers });
  }
  const response = await handle();
  if (!gate.cookie) return response;
  const out = new Response(response.body, response);
  out.headers.append("Set-Cookie", gate.cookie);
  return out;
}

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

// /portal itself or a path under /portal/. A bare startsWith("/portal") would also pass /portalx,
// and /portal//host would leave the origin once /portal is cut off.
function isPortalPath(path: string): boolean {
  if (path === PORTAL_PATH) return true;
  return path.startsWith(PORTAL_PREFIX) && isSameOriginPath(path.slice(PORTAL_PATH.length));
}

export async function handlePortalCallback(
  request: Request,
  env: Env,
  now: Date,
): Promise<Response> {
  const url = new URL(request.url);
  const flow = portalLogin(url);
  const login = await completeAccessLogin(request, env, flow, (stored) => stored, now);
  if (!login.ok) {
    logEvent(
      OWASP_EVENTS.signInFailure,
      {
        message: `Portal sign-in refused: ${login.code}`,
        app: "portal",
        via: "access",
        code: login.code,
      },
      { level: "warn" },
    );
    return login.response;
  }
  const { email, name, state: returnTo } = login;
  logEvent(OWASP_EVENTS.signInSuccess, {
    message: "Portal sign-in",
    app: "portal",
    via: "access",
    email_key: await emailKey("email", email),
  });

  // A relative Portal path only, checked rather than trusted from KV, so a bad write
  // cannot become an open redirect.
  // The stored path is internal (/portal/x); the browser on the Portal host goes to /x.
  const safeReturn = isPortalPath(returnTo) ? returnTo : PORTAL_PREFIX;
  const headers = new Headers({ Location: publicPortalPath(url, safeReturn) });
  headers.append(
    "Set-Cookie",
    await portalSessionCookie(
      name ? { email, name } : { email },
      env.COOKIE_ENCRYPTION_KEY,
      now,
      portalCookiePath(url),
    ),
  );
  headers.append("Set-Cookie", clearStateCookie(flow));
  return new Response(null, { status: 302, headers });
}

// A bearer token is refused, not redirected: an agent key cannot follow a login redirect, and a 302 to
// Access would look to it like the Portal being down.
const BEARER_REFUSAL =
  "forbidden: Capsid Portal admits the administrator's Access session only. An agent key authenticates to /ops/mcp, not to this page; the same state is served by capsid_read_status action status there. Open the Portal in a browser to sign in as the administrator.";

export type PortalGate = { ok: true; user: PortalUser } | { ok: false; response: Response };

export async function portalGate(
  request: Request,
  env: Env,
  now: Date,
  returnTo: string,
): Promise<PortalGate> {
  if (request.headers.get("Authorization")) {
    logEvent(
      OWASP_EVENTS.authorizationFailure,
      { message: "Portal refused a bearer token", app: "portal", reason: "bearer" },
      { level: "warn" },
    );
    return {
      ok: false,
      response: new Response(BEARER_REFUSAL, {
        status: 403,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      }),
    };
  }
  // Resource isolation (site-runtime isolationVerdict, R2): another site may link to a Portal page (a top-level GET
  // navigation) and nothing more, so no page elsewhere loads a signed-in response as an image, script, frame or fetch.
  if (!isolationVerdict(request).ok) return { ok: false, response: originRefusal() };
  const user = await readPortalSession(request, env, now);
  if (!user) return { ok: false, response: await startPortalLogin(request, env, returnTo) };
  return { ok: true, user };
}

export function queryParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name)?.trim();
  return raw ? raw : null;
}

export function behindGate<A extends unknown[]>(
  run: (request: Request, env: Env, now: Date, user: PortalUser, ...rest: A) => Promise<Response>,
) {
  return async (
    request: Request,
    env: Env,
    now: Date = new Date(),
    ...rest: A
  ): Promise<Response> => {
    const gate = await portalGate(request, env, now, PORTAL_PREFIX);
    return gate.ok ? run(request, env, now, gate.user, ...rest) : gate.response;
  };
}

// Cloudflare's edge sets CF-Connecting-IP and replaces any client value; anything not an IPv4 or IPv6
// address is recorded as null.
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;
export function sourceAddress(request: Request): string | null {
  const raw = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return ADDRESS.test(raw) && /[.:]/.test(raw) ? raw : null;
}
