import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { clearIdTokenKeysCache, type Jwk } from "../src/access-jwt.ts";
import { handleConsoleCallback, readConsoleSession, startConsoleLogin } from "../src/console-auth.ts";
import { fakeKv } from "./fakes.ts";

// The console's callback through the shared Access for SaaS login (src/access-login.ts),
// design PR 3 of capsid/research/design-capsid-access-login.md. The MCP callback is
// covered in test-integration/oauth-round-trip.test.ts. The console runs the same
// module with its own callback path, cookie name and Path, KV prefix and restart hint,
// so these drive a real round trip: start, then call back with Access's token and
// JWKS endpoints stubbed and a real RS256 ID token signed here.

const ORIGIN = "https://capsid.example";
const SECRET = "console-login-test-cookie-secret";
const ISSUER = "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/sample-client";
const realFetch = globalThis.fetch;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
)) as CryptoKeyPair;
const publicJwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk), kid: "console-kid" };

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const head = b64json({ alg: "RS256", kid: "console-kid", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64json({ iss: ISSUER, aud: "sample-client", iat: now, exp: now + 300, ...claims });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

beforeEach(() => {
  clearIdTokenKeysCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(overrides: Record<string, unknown> = {}) {
  return {
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_EMAIL: "admin@example.com",
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
    ...overrides,
  } as never;
}

// Stubs Access for one sign-in: the token endpoint answers with an ID token carrying
// the nonce the flow sent (or `claims` over it), the JWKS endpoint with the key.
// Returns the token requests' bodies.
function stubAccess(authorizationUrl: string, claims: Record<string, unknown> = {}): URLSearchParams[] {
  const nonce = new URL(authorizationUrl).searchParams.get("nonce");
  const bodies: URLSearchParams[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/token`) {
      bodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token: await idToken({ email: "admin@example.com", nonce, ...claims }) });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [publicJwk] });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return bodies;
}

async function started(e: never): Promise<{ state: string; cookie: string; location: string }> {
  const res = await startConsoleLogin(new Request(`${ORIGIN}/console`), e, "/console/json");
  assert.equal(res.status, 302);
  const location = String(res.headers.get("Location"));
  const state = String(new URL(location).searchParams.get("state"));
  return { state, cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0], location };
}

// Node's Headers has getSetCookie; the Workers types this suite checks against do not.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function callback(state: string, cookie: string): Request {
  return new Request(`${ORIGIN}/console/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
}

test("the start sets the console state cookie on Path=/console and sends Access the console callback, with PKCE and a nonce", async () => {
  const e = env();
  const res = await startConsoleLogin(new Request(`${ORIGIN}/console`), e, "/console");
  const location = new URL(String(res.headers.get("Location")));
  assert.equal(`${location.origin}${location.pathname}`, `${ISSUER}/authorization`);
  assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/console/callback`);
  assert.equal(location.searchParams.get("scope"), "openid email profile");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("nonce"));
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^capsid_console_state=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/console; Max-Age=600$/);
});

test("the admin completes the login: session cookie carries the email, state cookie cleared, state consumed", async () => {
  const e = env();
  const { state, cookie, location } = await started(e);
  const bodies = stubAccess(location);
  const res = await handleConsoleCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/console/json");
  assert.equal(bodies[0]?.get("redirect_uri"), `${ORIGIN}/console/callback`);
  assert.ok(bodies[0]?.get("code_verifier"), "the exchange sent no PKCE verifier");
  const cookies = setCookies(res);
  assert.equal(cookies.length, 2);
  assert.equal(cookies[1], "capsid_console_state=; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=0");
  const session = await readConsoleSession(
    new Request(`${ORIGIN}/console`, { headers: { Cookie: cookies[0].split(";")[0] } }),
    e,
    new Date()
  );
  assert.deepEqual(session, { email: "admin@example.com" });
  assert.equal(await (e as { OAUTH_KV: KVNamespace }).OAUTH_KV.get(`capsid:console-state:${state}`), null);
});

test("a state cookie that is not the digest of the state is refused with the console's restart hint", async () => {
  const e = env();
  const { state } = await started(e);
  const res = await handleConsoleCallback(callback(state, `capsid_console_state=${"0".repeat(64)}`), e, new Date());
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "state validation failed: this browser did not start the flow. Open /console again.");
});

test("the MCP flow's state cookie does not satisfy the console callback", async () => {
  const e = env();
  const { state, cookie } = await started(e);
  const res = await handleConsoleCallback(callback(state, cookie.replace("capsid_console_state=", "capsid_state=")), e, new Date());
  assert.equal(res.status, 403);
});

test("a state with no KV entry is refused as expired", async () => {
  const e = env();
  const { state, cookie } = await started(e);
  await (e as { OAUTH_KV: KVNamespace }).OAUTH_KV.delete(`capsid:console-state:${state}`);
  const res = await handleConsoleCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "state expired or already used. Open /console again.");
});

// Each of these reaches the ID token check and must end with no session cookie.
for (const [name, claims, overrides, pattern] of [
  ["an email that is not the admin", { email: "someone@example.com" }, {}, /not its administrator/],
  ["the admin's email in another case", { email: "Admin@example.com" }, {}, /not its administrator/],
  ["an unset ADMIN_EMAIL", {}, { ADMIN_EMAIL: undefined }, /not its administrator/],
  ["a wrong issuer", { iss: "https://other.cloudflareaccess.com/cdn-cgi/access/sso/oidc/sample-client" }, {}, /could not be verified/],
  ["a wrong audience", { aud: "other-client" }, {}, /could not be verified/],
  ["a nonce from another sign-in", { nonce: "someone-elses-nonce" }, {}, /could not be verified/],
  ["an expired token", { exp: Math.floor(Date.now() / 1000) - 60 }, {}, /could not be verified/],
] as const) {
  test(`${name} is refused and gets no session`, async () => {
    const e = env(overrides);
    const { state, cookie, location } = await started(e);
    stubAccess(location, claims);
    const res = await handleConsoleCallback(callback(state, cookie), e, new Date());
    assert.equal(res.status, 403);
    assert.match(await res.text(), pattern);
    assert.equal(res.headers.get("Set-Cookie"), null);
  });
}

test("Access reporting a refused sign-in on the callback gets no session and never reaches the token endpoint", async () => {
  const e = env();
  const { state, cookie } = await started(e);
  globalThis.fetch = (async () => {
    throw new Error("the callback called Access after an error");
  }) as typeof fetch;
  const res = await handleConsoleCallback(
    new Request(`${ORIGIN}/console/callback?error=access_denied&state=${state}`, { headers: { Cookie: cookie } }),
    e,
    new Date()
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Set-Cookie"), null);
});
