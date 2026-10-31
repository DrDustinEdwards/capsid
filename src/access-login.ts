import { accessSaas, authorizationUrl, finishSignIn, newSignIn, type KeySource } from "@dustinedwards/site-runtime/access-login";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { sha256Hex, toHex } from "@dustinedwards/site-runtime/encoding";
import { cookieName, getCookie, isAdminEmail } from "./auth";
import type { Env } from "./env";
// The sign-in round trip with Cloudflare Access for SaaS (OIDC) as the upstream
// identity (capsid/research/design-capsid-access-login.md, decided 2026-09-27) for
// Capsid Portal's login (src/portal-auth.ts); the MCP authorization flow is
// site-runtime's loginHandler (src/routes.ts). What the Portal stores and does with the
// admitted email stays in the caller. A state token is
// stored in OAUTH_KV for ten minutes, bound to the browser by a cookie holding a random
// value of its own whose digest the stored state keeps, and used once. PKCE and an OIDC nonce are kept in the stored state.
// The endpoints, the authorization URL, the code exchange and the ID token check are
// site-runtime's access-login, the sign-in every family MCP server uses. The person is the email in the token,
// admitted only when it equals ADMIN_EMAIL or a CO_OWNER_EMAILS entry exactly.

// How long a started login stays usable: the KV state entry and the state cookie.
const STATE_TTL_SECONDS = 600;

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
  return `${cookieName(flow.stateCookie, flow.cookiePath)}=; HttpOnly; Secure; SameSite=Lax; Path=${flow.cookiePath}; Max-Age=0`;
}

const UNCONFIGURED = "the sign-in is not configured (ACCESS_TEAM_DOMAIN, ACCESS_SAAS_CLIENT_ID, ACCESS_SAAS_CLIENT_SECRET), so it is closed";

// site-runtime's refusal codes, in the words a person reading the page needs.
const REFUSALS: Record<string, string> = {
  "invalid-id-token": "the ID token's signature, issuer, audience or dates do not check out",
  "nonce-mismatch": "the ID token's nonce is not this sign-in's",
  "email-not-verified": "the ID token says the email is not verified",
  "no-email": "the ID token carries no email",
};

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

// What the KV state holds: the caller's own value, this sign-in's PKCE verifier and
// nonce, which never leave the server, and the digest of the browser binding the state
// cookie carries.
interface StoredSignIn {
  stored: string;
  verifier: string;
  nonce: string;
  binding: string;
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
  // The browser binding is random and unrelated to the state token. A cookie derived
  // from the token could be computed by anyone holding the callback URL, which carries
  // the token, and would bind nothing (Grok audit 2026-10, S6).
  const binding = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const signIn: StoredSignIn = { stored, ...newSignIn(), binding: await sha256Hex(binding) };
  await env.OAUTH_KV.put(`${flow.kvPrefix}${stateToken}`, JSON.stringify(signIn), { expirationTtl: STATE_TTL_SECONDS });
  const target = await authorizationUrl(saas, { redirectUri: `${new URL(request.url).origin}${flow.callbackPath}`, state: stateToken, verifier: signIn.verifier, nonce: signIn.nonce });
  const headers = new Headers({ Location: target });
  // The state cookie carries the binding, which neither the URL nor the stored state holds.
  headers.append("Set-Cookie", `${cookieName(flow.stateCookie, flow.cookiePath)}=${binding}; HttpOnly; Secure; SameSite=Lax; Path=${flow.cookiePath}; Max-Age=${STATE_TTL_SECONDS}`);
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

// `code` names the refusal for the auth event log (src/portal-auth.ts), never shown.
export type AccessLoginResult<T> = { ok: true; email: string; name?: string; state: T } | { ok: false; code: string; response: Response };

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
  keys?: KeySource
): Promise<AccessLoginResult<T>> {
  const fail = (message: string, status: number, code: string): AccessLoginResult<T> => ({ ok: false, code, response: refusal(message, status) });
  const saas = accessSaas(env);
  if (!saas) return fail(UNCONFIGURED, 503, "NOT_CONFIGURED");
  const url = new URL(request.url);
  // Access reports a refused sign-in as error=... on the callback.
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) return fail(`the sign-in was refused by Access: ${upstreamError.slice(0, 80)}. ${flow.restartHint}`, 403, "ACCESS_REFUSED");
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) return fail("missing code or state", 400, "MISSING_CODE_OR_STATE");

  const notThisBrowser = `state validation failed: this browser did not start the flow. ${flow.restartHint}`;
  const stateCookie = getCookie(request, flow.stateCookie);
  if (!stateCookie) return fail(notThisBrowser, 403, "STATE_NOT_THIS_BROWSER");
  const stateKey = `${flow.kvPrefix}${stateToken}`;
  const raw = await env.OAUTH_KV.get(stateKey);
  if (!raw) return fail(`state expired or already used. ${flow.restartHint}`, 403, "STATE_EXPIRED");
  let signIn: StoredSignIn;
  try {
    signIn = JSON.parse(raw) as StoredSignIn;
    if (typeof signIn.verifier !== "string" || typeof signIn.nonce !== "string" || typeof signIn.stored !== "string" || typeof signIn.binding !== "string") {
      throw new Error("shape");
    }
  } catch {
    await env.OAUTH_KV.delete(stateKey);
    return fail(`stored authorization state is unreadable. ${flow.restartHint}`, 403, "STATE_UNREADABLE");
  }
  // A cookie that does not match leaves the state in place, so a stranger holding the
  // callback URL cannot spend the browser's sign-in.
  if (!await safeEqual(await sha256Hex(stateCookie), signIn.binding)) return fail(notThisBrowser, 403, "STATE_NOT_THIS_BROWSER");
  let state: T;
  try {
    state = parse(signIn.stored);
  } catch {
    await env.OAUTH_KV.delete(stateKey);
    return fail(`stored authorization state is unreadable. ${flow.restartHint}`, 403, "STATE_UNREADABLE");
  }

  // The state is consumed once the exchange is attempted, except when Access did not
  // answer or failed, so a transient Access error does not burn it. Replay is bounded by
  // Access, which honors a code once. The exchange gives up after 15 seconds (Grok audit
  // 2026-10-21, CA-10, now in site-runtime).
  const verdict = await finishSignIn(saas, { code, redirectUri: `${url.origin}${flow.callbackPath}`, verifier: signIn.verifier, nonce: signIn.nonce, now: now.getTime() }, keys);
  if (!verdict.ok && verdict.reason === "token-exchange-unanswered") return fail("the Access token exchange did not answer in time", 502, "TOKEN_EXCHANGE_UNANSWERED");
  if (!verdict.ok && verdict.reason.startsWith("token-exchange-")) return fail(`the Access token exchange failed (${verdict.reason.slice("token-exchange-".length)})`, 502, "TOKEN_EXCHANGE_FAILED");
  if (!verdict.ok && verdict.reason === "no-id-token") return fail("the Access token exchange returned no ID token", 502, "NO_ID_TOKEN");
  await env.OAUTH_KV.delete(stateKey);
  if (!verdict.ok) return fail(`the sign-in could not be verified: ${REFUSALS[verdict.reason] ?? verdict.reason}. ${flow.restartHint}`, 403, verdict.reason.toUpperCase().replaceAll("-", "_"));
  if (!await isAdminEmail(env, verdict.email)) {
    return fail("access denied: this email is not an administrator of capsid (ADMIN_EMAIL or CO_OWNER_EMAILS)", 403, "NOT_ADMIN");
  }
  return verdict.name ? { ok: true, email: verdict.email, name: verdict.name, state } : { ok: true, email: verdict.email, state };
}
