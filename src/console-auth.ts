import { clearStateCookie, completeAccessLogin, type LoginFlow, startAccessLogin } from "./access-login";
import { getCookie, hmacHex, isAdminEmail, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";

// The console's own session. The OAuth provider mints tokens for MCP clients, and a
// browser opening /console has nothing to present, so the console signs in through
// the same Access for SaaS app as the MCP login (src/access-login.ts, design PR 3 of
// capsid/research/design-capsid-access-login.md) with its own redirect URL, state
// cookie and KV prefix, and turns the verified email into a signed cookie. It does not
// go through the MCP provider, whose flow ends at a client redirect_uri.
//
// The cookie is a signed assertion (HMAC over a base64url payload with the email and
// an expiry), not a session record. It cannot be revoked before it expires, so the
// TTL is twelve hours and the admin check (ADMIN_EMAIL) runs again on every request.
// A cookie issued under the GitHub login carries a login and no email, so it fails
// that check and the console asks to sign in once.

const CONSOLE_SESSION_COOKIE = "capsid_console";
export const CONSOLE_CSRF_COOKIE = "capsid_console_csrf";
export const CONSOLE_SESSION_TTL_SECONDS = 12 * 60 * 60;

// The console's half of the Access login. The state stored against the token is the
// console path to return to.
const CONSOLE_LOGIN: LoginFlow = {
  callbackPath: "/console/callback",
  stateCookie: "capsid_console_state",
  cookiePath: "/console",
  kvPrefix: "capsid:console-state:",
  restartHint: "Open /console again.",
};

export interface ConsoleUser {
  email: string;
}

interface SessionPayload extends ConsoleUser {
  exp: number;
}

export async function consoleSessionCookie(user: ConsoleUser, secret: string, now: Date): Promise<string> {
  const payload: SessionPayload = {
    email: user.email,
    exp: Math.floor(now.getTime() / 1000) + CONSOLE_SESSION_TTL_SECONDS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(secret, encoded);
  return `${CONSOLE_SESSION_COOKIE}=${sig}.${encoded}; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=${CONSOLE_SESSION_TTL_SECONDS}`;
}

// The session's user, or null for anything that does not verify. The admin check
// means changing ADMIN_EMAIL invalidates every outstanding console cookie.
export async function readConsoleSession(request: Request, env: Env, now: Date): Promise<ConsoleUser | null> {
  const raw = getCookie(request, CONSOLE_SESSION_COOKIE);
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
  return { email: payload.email };
}

export function startConsoleLogin(request: Request, env: Env, returnTo: string): Promise<Response> {
  return startAccessLogin(request, env, CONSOLE_LOGIN, returnTo);
}

export async function handleConsoleCallback(request: Request, env: Env, now: Date): Promise<Response> {
  const login = await completeAccessLogin(request, env, CONSOLE_LOGIN, (stored) => stored, now);
  if (!login.ok) return login.response;
  const { email, state: returnTo } = login;

  // A relative console path only, checked rather than trusted from KV, so a bad
  // write cannot become an open redirect.
  const safeReturn = returnTo.startsWith("/console") ? returnTo : "/console";
  const headers = new Headers({ Location: safeReturn });
  headers.append("Set-Cookie", await consoleSessionCookie({ email }, env.COOKIE_ENCRYPTION_KEY, now));
  headers.append("Set-Cookie", clearStateCookie(CONSOLE_LOGIN));
  return new Response(null, { status: 302, headers });
}
