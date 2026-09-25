import { getCookie, hmacHex, isAdminUser, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { clearStateCookie, completeGithubLogin, type GithubLoginFlow, startGithubLogin } from "./github-login";

// The console's own session. The OAuth provider mints tokens for MCP clients, and a
// browser opening /console has nothing to present, so the console uses the same
// GitHub OAuth app and admin check (isAdminUser) and turns the result into a signed
// cookie. It does not go through the MCP provider, whose flow ends at a client
// redirect_uri.
//
// The cookie is a signed assertion (HMAC over a base64url payload with the login and
// an expiry), not a session record. It cannot be revoked before it expires, so the
// TTL is twelve hours and the admin check runs again on every request.

const CONSOLE_SESSION_COOKIE = "capsid_console";
export const CONSOLE_CSRF_COOKIE = "capsid_console_csrf";
export const CONSOLE_SESSION_TTL_SECONDS = 12 * 60 * 60;

// The console's half of the GitHub login (src/github-login.ts). The state stored
// against the token is the console path to return to.
const CONSOLE_LOGIN: GithubLoginFlow = {
  callbackPath: "/console/callback",
  stateCookie: "capsid_console_state",
  cookiePath: "/console",
  kvPrefix: "capsid:console-state:",
  restartHint: "Open /console again.",
};

export interface ConsoleUser {
  login: string;
  id: number | string;
}

interface SessionPayload extends ConsoleUser {
  exp: number;
}

export async function consoleSessionCookie(user: ConsoleUser, secret: string, now: Date): Promise<string> {
  const payload: SessionPayload = {
    login: user.login,
    id: user.id,
    exp: Math.floor(now.getTime() / 1000) + CONSOLE_SESSION_TTL_SECONDS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(secret, encoded);
  return `${CONSOLE_SESSION_COOKIE}=${sig}.${encoded}; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=${CONSOLE_SESSION_TTL_SECONDS}`;
}

// The session's user, or null for anything that does not verify. The admin check
// means changing ADMIN_GITHUB_LOGIN invalidates every outstanding console cookie.
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
  if (typeof payload?.login !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 <= now.getTime()) return null;
  if (!isAdminUser(env, { id: payload.id, login: payload.login })) return null;
  return { login: payload.login, id: payload.id };
}

export function startConsoleLogin(request: Request, env: Env, returnTo: string): Promise<Response> {
  return startGithubLogin(request, env, CONSOLE_LOGIN, returnTo);
}

export async function handleConsoleCallback(request: Request, env: Env, now: Date): Promise<Response> {
  const login = await completeGithubLogin(request, env, CONSOLE_LOGIN, (stored) => stored);
  if (!login.ok) return login.response;
  const { user, state: returnTo } = login;

  // A relative console path only, checked rather than trusted from KV, so a bad
  // write cannot become an open redirect.
  const safeReturn = returnTo.startsWith("/console") ? returnTo : "/console";
  const headers = new Headers({ Location: safeReturn });
  headers.append("Set-Cookie", await consoleSessionCookie(user, env.COOKIE_ENCRYPTION_KEY, now));
  headers.append("Set-Cookie", clearStateCookie(CONSOLE_LOGIN));
  return new Response(null, { status: 302, headers });
}
