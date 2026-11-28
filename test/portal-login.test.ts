import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { stubAccess } from "@dustinedwards/devkit/access";
import { forgetKeys } from "@dustinedwards/site-runtime/access-login";
import { hmacSha256Hex } from "@dustinedwards/site-runtime/encoding";
import {
  handlePortalCallback,
  portalSessionCookie,
  portalSignOutCookies,
  readPortalSession,
  startPortalLogin,
  withPortalIdle,
} from "../src/portal-auth.ts";
import { portalCsrf } from "../src/ops-feed.ts";
import { PORTAL_HOST } from "../src/portal-host.ts";
import { fakeKv, withPortalSessionEnds } from "./fakes.ts";

// The Portal callback through the shared Access login (src/access-login.ts), a real round trip with Access's
// token and JWKS endpoints stubbed and a real RS256 ID token signed here.

const ORIGIN = "https://capsid.example";
const SECRET = "portal-login-test-cookie-secret";
const ISSUER = "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/sample-client";
const realFetch = globalThis.fetch;

beforeEach(() => {
  forgetKeys();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(overrides: Record<string, unknown> = {}) {
  return {
    OAUTH_KV: fakeKv().kv,
    DB: withPortalSessionEnds().db,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_EMAIL: "admin@example.com",
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
    ...overrides,
  } as never;
}

// Stubs Access's token and JWKS endpoints; the ID token carries the nonce the flow sent, or `claims` over it.
// Returns the token requests' bodies.
async function stubPortalAccess(
  authorizationUrl: string,
  claims: Record<string, unknown> = {},
): Promise<URLSearchParams[]> {
  const access = await stubAccess({
    issuer: ISSUER,
    audience: "sample-client",
    email: "admin@example.com",
    authorizationUrl,
    claims,
  });
  return access.tokenRequests;
}

async function started(
  e: never,
  returnTo = "/portal/board",
): Promise<{ state: string; cookie: string; location: string }> {
  const res = await startPortalLogin(new Request(`${ORIGIN}/portal/`), e, returnTo);
  assert.equal(res.status, 302);
  const location = String(res.headers.get("Location"));
  const state = String(new URL(location).searchParams.get("state"));
  return {
    state,
    cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0],
    location,
  };
}

// Node's Headers has getSetCookie; the Workers types this suite checks against do not.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function callback(state: string, cookie: string): Request {
  return new Request(`${ORIGIN}/portal/callback?code=c&state=${state}`, {
    headers: { Cookie: cookie },
  });
}

test("the start sets the Portal state cookie on Path=/portal and sends Access the Portal callback, with PKCE and a nonce", async () => {
  const e = env();
  const res = await startPortalLogin(new Request(`${ORIGIN}/portal/`), e, "/portal/");
  const location = new URL(String(res.headers.get("Location")));
  assert.equal(`${location.origin}${location.pathname}`, `${ISSUER}/authorization`);
  assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/portal/callback`);
  assert.equal(location.searchParams.get("scope"), "openid email profile");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("nonce"));
  const cookies = setCookies(res);
  assert.equal(cookies.length, 1);
  assert.match(
    cookies[0],
    /^__Secure-capsid_portal_state=[0-9a-f]{64}; Path=\/portal; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );
});

test("the admin completes the login: session cookie carries the email, state cookie cleared, state consumed", async () => {
  const e = env();
  const { state, cookie, location } = await started(e);
  const bodies = await stubPortalAccess(location);
  const res = await handlePortalCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/portal/board");
  assert.equal(bodies[0]?.get("redirect_uri"), `${ORIGIN}/portal/callback`);
  assert.ok(bodies[0]?.get("code_verifier"), "the exchange sent no PKCE verifier");
  const cookies = setCookies(res);
  assert.equal(cookies.length, 2);
  assert.match(
    cookies[0],
    /^__Secure-capsid_portal=[0-9a-f]+\.[A-Za-z0-9_-]+; Path=\/portal; Secure; HttpOnly; SameSite=Lax; Max-Age=90000$/,
  );
  assert.equal(
    cookies[1],
    "__Secure-capsid_portal_state=; Path=/portal; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  const session = await readPortalSession(
    new Request(`${ORIGIN}/portal/`, {
      headers: { Cookie: cookies[0].split(";")[0] },
    }),
    e,
    new Date(),
  );
  assert.deepEqual(session, { email: "admin@example.com" });
  assert.equal(
    await (e as { OAUTH_KV: KVNamespace }).OAUTH_KV.get(`capsid:portal-state:${state}`),
    null,
  );
});

test("the name in the ID token rides the session cookie, and a token with no name leaves the session email-only", async () => {
  for (const [claims, expected] of [
    [{ name: "Dustin Edwards" }, { email: "admin@example.com", name: "Dustin Edwards" }],
    [{}, { email: "admin@example.com" }],
  ] as const) {
    const e = env();
    const { state, cookie, location } = await started(e);
    await stubPortalAccess(location, claims);
    const res = await handlePortalCallback(callback(state, cookie), e, new Date());
    const session = await readPortalSession(
      new Request(`${ORIGIN}/portal/`, {
        headers: { Cookie: setCookies(res)[0].split(";")[0] },
      }),
      e,
      new Date(),
    );
    assert.deepEqual(session, expected);
  }
});

test("a state cookie that is not the digest of the state, or is the MCP flow's, is refused with the Portal's restart hint", async () => {
  const e = env();
  const { state } = await started(e);
  const res = await handlePortalCallback(
    callback(state, `__Secure-capsid_portal_state=${"0".repeat(64)}`),
    e,
    new Date(),
  );
  assert.equal(res.status, 403);
  assert.equal(
    await res.text(),
    "state validation failed: this browser did not start the flow. Open /portal again.",
  );
  // The MCP flow's state cookie does not satisfy the Portal callback.
  const { state: s2, cookie } = await started(e);
  const mcp = await handlePortalCallback(
    callback(s2, cookie.replace("capsid_portal_state=", "capsid_state=")),
    e,
    new Date(),
  );
  assert.equal(mcp.status, 403);
});

test("a state with no KV entry is refused as expired", async () => {
  const e = env();
  const { state, cookie } = await started(e);
  await (e as { OAUTH_KV: KVNamespace }).OAUTH_KV.delete(`capsid:portal-state:${state}`);
  const res = await handlePortalCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "state expired or already used. Open /portal again.");
});

// Access's ID token checks are site-runtime's; these are Capsid's admission rules.
for (const [name, claims, overrides, pattern] of [
  [
    "an email that is not the admin",
    { email: "someone@example.com" },
    {},
    /not an administrator of capsid/,
  ],
  ["an unset ADMIN_EMAIL", {}, { ADMIN_EMAIL: undefined }, /not an administrator of capsid/],
  [
    "a co-owner when CO_OWNER_EMAILS is empty",
    { email: "co@example.com" },
    { CO_OWNER_EMAILS: "" },
    /not an administrator of capsid/,
  ],
] as const) {
  test(`${name} is refused and gets no session`, async () => {
    const e = env(overrides);
    const { state, cookie, location } = await started(e);
    await stubPortalAccess(location, claims);
    const res = await handlePortalCallback(callback(state, cookie), e, new Date());
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
  const res = await handlePortalCallback(
    new Request(`${ORIGIN}/portal/callback?error=access_denied&state=${state}`, {
      headers: { Cookie: cookie },
    }),
    e,
    new Date(),
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("PLANT: a stored return path outside the Portal lands on the Portal's home, on either host", async () => {
  for (const [origin, home] of [
    [ORIGIN, "/portal/"],
    ["https://portal.dustinedwards.info", "/"],
  ] as const)
    for (const stored of [
      "/portal//attacker.example",
      "/portalx",
      "/elsewhere",
      "https://example.com/portal/",
      "//example.com/portal/",
    ]) {
      const e = env();
      const start = await startPortalLogin(new Request(`${origin}/portal/`), e, stored);
      const location = String(start.headers.get("Location"));
      const state = String(new URL(location).searchParams.get("state"));
      await stubPortalAccess(location);
      const res = await handlePortalCallback(
        new Request(`${origin}/portal/callback?code=c&state=${state}`, {
          headers: { Cookie: setCookies(start)[0].split(";")[0] },
        }),
        e,
        new Date(),
      );
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("Location"), home, `${origin} ${stored}`);
    }
});

// The router hands these handlers the rewritten request (/x on the Portal host is /portal/x here).
const PORTAL_ORIGIN = `https://${PORTAL_HOST}`;

// Domain=dustinedwards.info would hand the session to every subdomain, the public sites included.
test("PLANT: each host's login sends Access its own callback and returns there; no Portal cookie carries a Domain, and each is scoped to its host's Portal path", async () => {
  for (const [origin, path, callbackPath, back] of [
    [ORIGIN, "/portal", "/portal/callback", "/portal/board"],
    [PORTAL_ORIGIN, "/", "/callback", "/board"],
  ] as const) {
    const e = env();
    const start = await startPortalLogin(new Request(`${origin}/portal/`), e, "/portal/board");
    const location = String(start.headers.get("Location"));
    assert.equal(new URL(location).searchParams.get("redirect_uri"), `${origin}${callbackPath}`);
    const bodies = await stubPortalAccess(location);
    const state = String(new URL(location).searchParams.get("state"));
    const done = await handlePortalCallback(
      new Request(`${origin}/portal/callback?code=c&state=${state}`, {
        headers: { Cookie: setCookies(start)[0].split(";")[0] },
      }),
      e,
      new Date(),
    );
    assert.equal(done.headers.get("Location"), back);
    assert.equal(
      bodies[0]?.get("redirect_uri"),
      `${origin}${callbackPath}`,
      "the exchange names another callback",
    );
    const csrf = portalCsrf(new Request(`${origin}/portal/api/ops`)).setCookie;
    assert.ok(csrf, "a request with no CSRF cookie must be given one");
    const cookies = [
      ...setCookies(start),
      ...setCookies(done),
      ...portalSignOutCookies(path),
      csrf,
    ];
    assert.equal(cookies.length, 6);
    for (const cookie of cookies) {
      assert.doesNotMatch(
        cookie,
        /;\s*domain\s*=/i,
        `${origin} set a cookie with a Domain: ${cookie}`,
      );
      const attributes = cookie.split(";").map((a) => a.trim());
      assert.ok(
        attributes.includes(`Path=${path}`),
        `${origin} set a cookie outside ${path}: ${cookie}`,
      );
    }
  }
});

test("a co-owner completes the login: the cookie carries her email and verifies on a later request", async () => {
  const e = env({ CO_OWNER_EMAILS: " other@example.com , co@example.com " });
  const { state, cookie, location } = await started(e);
  await stubPortalAccess(location, { email: "co@example.com" });
  const res = await handlePortalCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 302);
  const session = await readPortalSession(
    new Request(`${ORIGIN}/portal/`, {
      headers: { Cookie: setCookies(res)[0].split(";")[0] },
    }),
    e,
    new Date(),
  );
  assert.deepEqual(session, { email: "co@example.com" });
  // PLANT: the same payload signed with the root secret itself does not verify: the root secret signs nothing.
  const value = setCookies(res)[0].split(";")[0];
  const encoded = value.slice(value.indexOf(".") + 1);
  const rootSigned = `${value.slice(0, value.indexOf("=") + 1)}${await hmacSha256Hex(SECRET, encoded)}.${encoded}`;
  assert.equal(
    await readPortalSession(
      new Request(`${ORIGIN}/portal/`, { headers: { Cookie: rootSigned } }),
      e,
      new Date(),
    ),
    null,
    "a cookie signed with COOKIE_ENCRYPTION_KEY itself verified",
  );
  const removed = await readPortalSession(
    new Request(`${ORIGIN}/portal/`, {
      headers: { Cookie: setCookies(res)[0].split(";")[0] },
    }),
    env({ CO_OWNER_EMAILS: "other@example.com" }),
    new Date(),
  );
  assert.equal(removed, null);
});

// An hour with no request ends the Portal and Access sessions (site-runtime's adminIdle); the timing is tested there.
test("PLANT: an hour with no request sends the browser to Access's logout and ends the session; an active one is let through", async () => {
  const e = env();
  const signedIn = new Date("2026-09-28T12:00:00.000Z");
  const session = (
    await portalSessionCookie({ email: "admin@example.com" }, SECRET, signedIn)
  ).split(";")[0];
  const at = (minutes: number) => new Date(signedIn.getTime() + minutes * 60_000);
  const handled: string[] = [];
  const handle = async () => (handled.push("served"), new Response("ok"));

  const first = await withPortalIdle(
    new Request(`${ORIGIN}/portal/`, { headers: { Cookie: session } }),
    e,
    handle,
    at(30),
  );
  assert.equal(first.status, 200);
  const seen = setCookies(first)
    .find((c) => c.startsWith("__Host-admin-seen="))
    ?.split(";")[0];
  assert.ok(seen, "an active request did not record itself");

  const second = await withPortalIdle(
    new Request(`${ORIGIN}/portal/`, {
      headers: { Cookie: `${session}; ${seen}` },
    }),
    e,
    handle,
    at(80),
  );
  assert.equal(second.status, 200);
  assert.equal(handled.length, 2);
  const seen2 = setCookies(second)
    .find((c) => c.startsWith("__Host-admin-seen="))
    ?.split(";")[0];

  // The page's own poll (X-Background) is served but is not a request by the admin.
  const poll = await withPortalIdle(
    new Request(`${ORIGIN}/portal/api/ops`, {
      headers: { Cookie: `${session}; ${seen2}`, "X-Background": "1" },
    }),
    e,
    handle,
    at(120),
  );
  assert.equal(poll.status, 200);
  assert.ok(
    !setCookies(poll).some((c) => c.startsWith("__Host-admin-seen=")),
    "a background poll kept the session active",
  );

  // 150 minutes in, 70 after the last request by the admin (the poll at 120 does not count): idle.
  const idle = await withPortalIdle(
    new Request(`${ORIGIN}/portal/`, {
      headers: { Cookie: `${session}; ${seen2}` },
    }),
    e,
    handle,
    at(150),
  );
  assert.equal(idle.status, 302);
  assert.equal(
    idle.headers.get("Location"),
    "https://sample.cloudflareaccess.com/cdn-cgi/access/logout",
  );
  assert.equal(handled.length, 3, "an idle request reached the Portal");
  assert.ok(setCookies(idle).some((c) => /^__Secure-capsid_portal=;.*Max-Age=0/.test(c)));
  assert.equal(
    await readPortalSession(
      new Request(`${ORIGIN}/portal/`, { headers: { Cookie: session } }),
      e,
      at(151),
    ),
    null,
    "the idle session's cookie still verifies",
  );
});
