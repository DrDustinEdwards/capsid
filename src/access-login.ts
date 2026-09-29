import { verifyIdToken, type KeysFetcher } from "./access-jwt";
import { getCookie, isAdminEmail, sha256Hex, timingSafeEqual } from "./auth";
import type { Env } from "./env";
// The sign-in round trip with Cloudflare Access for SaaS (OIDC) as the upstream
// identity (capsid/research/design-capsid-access-login.md, decided 2026-09-27), shared
// by the MCP authorization flow (src/routes.ts) and Capsid Portal's login
// (src/portal-auth.ts). What differs between them is passed in as a LoginFlow; what
// each stores and does with the admitted email stays in the caller. A state token is
// stored in OAUTH_KV for ten minutes, bound to the browser by a cookie holding its
// digest, and used once. PKCE and an OIDC nonce are kept in the stored state, and the
// ID token is verified in src/access-jwt.ts. The person is the email in the token,
// admitted only when it equals ADMIN_EMAIL exactly.
//
// Every endpoint derives from the team domain and the client id, as the SaaS app's
// discovery document states them (measured 2026-09-27).

// How long a started login stays usable: the KV state entry and the state cookie.
export const STATE_TTL_SECONDS = 600;

export interface LoginFlow {
  // The path Access redirects back to, on this Worker's origin.
  callbackPath: string;
  stateCookie: string;
  // The state cookie's Path attribute.
  cookiePath: string;
  kvPrefix: string;
  // Appended to each state refusal, telling the user where to start again.
  restartHint: string;
}

export function clearStateCookie(flow: LoginFlow): string {
  return `${flow.stateCookie}=; HttpOnly; Secure; SameSite=Lax; Path=${flow.cookiePath}; Max-Age=0`;
}

export interface AccessSaas {
  clientId: string;
  clientSecret: string;
  issuer: string;
}

// The SaaS app's settings, or null while any is unset: the login is then closed.
function accessSaas(env: Env): AccessSaas | null {
  const team = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/+$/, "");
  const clientId = env.ACCESS_SAAS_CLIENT_ID?.trim();
  const clientSecret = env.ACCESS_SAAS_CLIENT_SECRET?.trim();
  if (!team || !clientId || !clientSecret) return null;
  return { clientId, clientSecret, issuer: `${team}/cdn-cgi/access/sso/oidc/${encodeURIComponent(clientId)}` };
}

const UNCONFIGURED = "the sign-in is not configured (ACCESS_TEAM_DOMAIN, ACCESS_SAAS_CLIENT_ID, ACCESS_SAAS_CLIENT_SECRET), so it is closed";

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

// What the KV state holds: the caller's own value, and this sign-in's PKCE verifier and
// nonce, which never leave the server.
interface StoredSignIn {
  stored: string;
  verifier: string;
  nonce: string;
}

// Stores `stored` against a fresh state token and redirects to Access.
export async function startAccessLogin(
  request: Request,
  env: Env,
  flow: LoginFlow,
  stored: string,
  extraCookies: string[] = []
): Promise<Response> {
  const saas = accessSaas(env);
  if (!saas) return refusal(UNCONFIGURED, 503);
  const stateToken = crypto.randomUUID();
  const signIn: StoredSignIn = { stored, verifier: base64Url(crypto.getRandomValues(new Uint8Array(32))), nonce: crypto.randomUUID() };
  await env.OAUTH_KV.put(`${flow.kvPrefix}${stateToken}`, JSON.stringify(signIn), { expirationTtl: STATE_TTL_SECONDS });
  const target = new URL(`${saas.issuer}/authorization`);
  target.searchParams.set("client_id", saas.clientId);
  target.searchParams.set("redirect_uri", `${new URL(request.url).origin}${flow.callbackPath}`);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", stateToken);
  target.searchParams.set("nonce", signIn.nonce);
  target.searchParams.set("code_challenge", await s256(signIn.verifier));
  target.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({ Location: target.href });
  // The state cookie carries a DIGEST of the token, so the cookie alone is not the token.
  headers.append(
    "Set-Cookie",
    `${flow.stateCookie}=${await sha256Hex(stateToken)}; HttpOnly; Secure; SameSite=Lax; Path=${flow.cookiePath}; Max-Age=${STATE_TTL_SECONDS}`
  );
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export type AccessLoginResult<T> = { ok: true; email: string; state: T } | { ok: false; response: Response };

// Verifies the callback's state against the cookie and KV, exchanges the code with
// PKCE, verifies the ID token and runs the admin check. `parse` turns the caller's
// stored value back into what it stored; if it throws, the state is deleted and the
// callback refused before anything reaches Access.
export async function completeAccessLogin<T>(
  request: Request,
  env: Env,
  flow: LoginFlow,
  parse: (stored: string) => T,
  now: Date = new Date(),
  fetchKeys?: KeysFetcher
): Promise<AccessLoginResult<T>> {
  const fail = (message: string, status: number): AccessLoginResult<T> => ({ ok: false, response: refusal(message, status) });
  const saas = accessSaas(env);
  if (!saas) return fail(UNCONFIGURED, 503);
  const url = new URL(request.url);
  // Access reports a refused sign-in as error=... on the callback.
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) return fail(`the sign-in was refused by Access: ${upstreamError.slice(0, 80)}. ${flow.restartHint}`, 403);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) return fail("missing code or state", 400);

  const stateCookie = getCookie(request, flow.stateCookie);
  if (!stateCookie || !timingSafeEqual(stateCookie, await sha256Hex(stateToken))) {
    return fail(`state validation failed: this browser did not start the flow. ${flow.restartHint}`, 403);
  }
  const stateKey = `${flow.kvPrefix}${stateToken}`;
  const raw = await env.OAUTH_KV.get(stateKey);
  if (!raw) return fail(`state expired or already used. ${flow.restartHint}`, 403);
  let signIn: StoredSignIn;
  let state: T;
  try {
    signIn = JSON.parse(raw) as StoredSignIn;
    if (typeof signIn.verifier !== "string" || typeof signIn.nonce !== "string" || typeof signIn.stored !== "string") throw new Error("shape");
    state = parse(signIn.stored);
  } catch {
    await env.OAUTH_KV.delete(stateKey);
    return fail(`stored authorization state is unreadable. ${flow.restartHint}`, 403);
  }

  const tokenResp = await fetch(`${saas.issuer}/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}${flow.callbackPath}`,
      client_id: saas.clientId,
      client_secret: saas.clientSecret,
      code_verifier: signIn.verifier,
    }),
  });
  if (!tokenResp.ok) return fail(`the Access token exchange failed (${tokenResp.status})`, 502);
  const tokens = (await tokenResp.json().catch(() => ({}))) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") return fail("the Access token exchange returned no ID token", 502);
  // The state is consumed after the exchange, so a transient Access error does not burn
  // it. Replay is bounded by Access, which honours a code once.
  await env.OAUTH_KV.delete(stateKey);

  const verdict = await verifyIdToken(
    tokens.id_token,
    { issuer: saas.issuer, clientId: saas.clientId, jwksUrl: `${saas.issuer}/jwks`, nonce: signIn.nonce },
    now,
    fetchKeys
  );
  if (!verdict.ok) return fail(`the sign-in could not be verified: ${verdict.reason}. ${flow.restartHint}`, 403);
  if (!isAdminEmail(env, verdict.email)) {
    return fail("access denied: capsid is a single-user server and this email is not its administrator", 403);
  }
  return { ok: true, email: verdict.email, state };
}
