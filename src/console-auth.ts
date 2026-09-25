import { getCookie, hmacHex, isAdminUser, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";
import { clearStateCookie, completeGithubLogin, type GithubLoginFlow, startGithubLogin } from "./github-login";

// THE CONSOLE'S OWN SESSION, and why it needs one.
//
// The OAuth provider in src/index.ts mints tokens for MCP CLIENTS. There is no
// browser session anywhere in this Worker: /authorize exists to hand a token to
// claude.ai, and the only cookie it leaves is the per-client approval. A human
// opening /console in a browser has nothing to present.
//
// So the console rides the SAME GitHub OAuth app and the SAME admin check
// (isAdminUser against ADMIN_GITHUB_LOGIN), and turns the result into a signed
// cookie. What it deliberately does NOT do is go through the MCP provider: that
// flow ends by redirecting to a registered client redirect_uri with an
// authorization code, which is the wrong shape for a page a person reads.
//
// THE COOKIE IS A SIGNED ASSERTION, NOT A SESSION RECORD. Same construction as the
// approval cookie: an HMAC over a base64url payload, with the login and an expiry
// inside. No server-side session table, so nothing to reap. The cost of that choice
// is stated rather than hidden: a cookie cannot be revoked before it expires, which
// is why the TTL is twelve hours and why the admin check runs again on every request
// rather than being trusted from the payload.

const CONSOLE_SESSION_COOKIE = "capsid_console";
// Read by the action handler and written by the page render, so it lives with the
// other cookie names rather than in whichever module happened to need it first.
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

// Returns the session's user, or null for anything that does not verify: no cookie,
// a bad signature, an unreadable payload, an expired one, or a login that is no
// longer the configured admin. That last check is what matters after the fact:
// changing ADMIN_GITHUB_LOGIN invalidates every outstanding console cookie.
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

// ---- the login round trip ----------------------------------------------------

export function startConsoleLogin(request: Request, env: Env, returnTo: string): Promise<Response> {
  return startGithubLogin(request, env, CONSOLE_LOGIN, returnTo);
}

export async function handleConsoleCallback(request: Request, env: Env, now: Date): Promise<Response> {
  const login = await completeGithubLogin(request, env, CONSOLE_LOGIN, (stored) => stored);
  if (!login.ok) return login.response;
  const { user, state: returnTo } = login;

  // A relative console path only, checked here rather than trusted from KV: the value
  // was written by this Worker, and treating it as a URL anyway would leave an open
  // redirect one bad write away.
  const safeReturn = returnTo.startsWith("/console") ? returnTo : "/console";
  const headers = new Headers({ Location: safeReturn });
  headers.append("Set-Cookie", await consoleSessionCookie(user, env.COOKIE_ENCRYPTION_KEY, now));
  headers.append("Set-Cookie", clearStateCookie(CONSOLE_LOGIN));
  return new Response(null, { status: 302, headers });
}
