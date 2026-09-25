import { getCookie, isAdminUser, sha256Hex, timingSafeEqual } from "./auth";
import type { Env } from "./env";

// The GitHub login round trip, shared by the MCP authorization flow (src/routes.ts)
// and the console login (src/console-auth.ts). What differs between them is passed
// in as a GithubLoginFlow; what each stores and does with the admitted user stays in
// the caller.

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

// How long a started login stays usable: the KV state entry and the state cookie.
export const STATE_TTL_SECONDS = 600;

export interface GithubLoginFlow {
  // The path GitHub redirects back to, on this Worker's origin.
  callbackPath: string;
  stateCookie: string;
  // The state cookie's Path attribute.
  cookiePath: string;
  kvPrefix: string;
  // Appended to each state refusal, telling the user where to start again.
  restartHint: string;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

export type GithubLoginResult<T> =
  | { ok: true; user: GithubUser; state: T }
  | { ok: false; response: Response };

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

export function clearStateCookie(flow: GithubLoginFlow): string {
  return `${flow.stateCookie}=; HttpOnly; Secure; SameSite=Lax; Path=${flow.cookiePath}; Max-Age=0`;
}

// Stores `stored` against a fresh state token and redirects to GitHub. The extra
// cookies are appended after the state cookie.
export async function startGithubLogin(
  request: Request,
  env: Env,
  flow: GithubLoginFlow,
  stored: string,
  extraCookies: string[] = []
): Promise<Response> {
  const stateToken = crypto.randomUUID();
  await env.OAUTH_KV.put(`${flow.kvPrefix}${stateToken}`, stored, { expirationTtl: STATE_TTL_SECONDS });
  const origin = new URL(request.url).origin;
  const target = new URL(GITHUB_AUTHORIZE_URL);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${origin}${flow.callbackPath}`);
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("state", stateToken);
  const headers = new Headers({ Location: target.href });
  // The state cookie carries a DIGEST of the token, so the cookie alone is not the
  // token.
  headers.append(
    "Set-Cookie",
    `${flow.stateCookie}=${await sha256Hex(stateToken)}; HttpOnly; Secure; SameSite=Lax; Path=${flow.cookiePath}; Max-Age=${STATE_TTL_SECONDS}`
  );
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

// Verifies the callback's state against the cookie and KV, exchanges the code, fetches
// the user and runs the admin check. `parse` turns the stored value back into what the
// caller stored; if it throws, the state is deleted and the callback refused before
// anything reaches GitHub.
export async function completeGithubLogin<T>(
  request: Request,
  env: Env,
  flow: GithubLoginFlow,
  parse: (stored: string) => T
): Promise<GithubLoginResult<T>> {
  const fail = (message: string, status: number): GithubLoginResult<T> => ({ ok: false, response: refusal(message, status) });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) return fail("missing code or state", 400);

  const stateCookie = getCookie(request, flow.stateCookie);
  if (!stateCookie || !timingSafeEqual(stateCookie, await sha256Hex(stateToken))) {
    return fail(`state validation failed: this browser did not start the flow. ${flow.restartHint}`, 403);
  }
  const stateKey = `${flow.kvPrefix}${stateToken}`;
  const stored = await env.OAUTH_KV.get(stateKey);
  if (!stored) return fail(`state expired or already used. ${flow.restartHint}`, 403);
  // A corrupt stored payload is a 403 telling the user to start again, not a throw.
  let state: T;
  try {
    state = parse(stored);
  } catch {
    await env.OAUTH_KV.delete(stateKey);
    return fail(`stored authorization state is unreadable. ${flow.restartHint}`, 403);
  }

  const tokenResp = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}${flow.callbackPath}`,
    }),
  });
  if (!tokenResp.ok) return fail("github token exchange failed", 502);
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  if (!tokenData.access_token) return fail("github token exchange failed: no access token returned", 502);
  // The state is consumed after the exchange, so a transient GitHub error does not
  // burn it and a reload still works. Replay is bounded by GitHub, which honours a
  // code once.
  await env.OAUTH_KV.delete(stateKey);

  const userResp = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "capsid",
    },
  });
  if (!userResp.ok) return fail("failed to fetch github user", 502);
  const user = (await userResp.json()) as GithubUser;
  if (!isAdminUser(env, user)) {
    return fail(
      `access denied: capsid is a single-user server and GitHub account "${user.login}" is not its administrator`,
      403
    );
  }
  return { ok: true, user, state };
}
