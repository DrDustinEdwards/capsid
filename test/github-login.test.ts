import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { handleConsoleCallback, readConsoleSession, startConsoleLogin } from "../src/console-auth.ts";
import { fakeKv } from "./fakes.ts";

// THE CONSOLE'S CALLBACK THROUGH THE SHARED GITHUB LOGIN (src/github-login.ts).
//
// The MCP callback's refusals are covered in test-integration/oauth.test.ts and
// oauth-flow.test.ts. The console callback had no test, and it now runs the same
// module with different parameters (callback path, cookie name and Path, KV prefix,
// restart hint), so these drive a real round trip through it: start, then call back
// with GitHub's two endpoints stubbed.

const ORIGIN = "https://capsid.example";
const SECRET = "github-login-test-cookie-secret";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(overrides: Record<string, unknown> = {}) {
  return {
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ...overrides,
  } as never;
}

// Stubs GitHub: the token endpoint answers with a token, the user endpoint with `login`.
// Returns the token exchange bodies so a test can read the redirect_uri sent.
function stubGithub(login: string): URLSearchParams[] {
  const exchanges: URLSearchParams[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      exchanges.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: "gho_test" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 7, login, name: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return exchanges;
}

async function started(e: never): Promise<{ state: string; cookie: string; setCookie: string }> {
  const res = await startConsoleLogin(new Request(`${ORIGIN}/console`), e, "/console/json");
  assert.equal(res.status, 302);
  const state = String(new URL(String(res.headers.get("Location"))).searchParams.get("state"));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  return { state, cookie: setCookie.split(";")[0], setCookie };
}

// Node's Headers has getSetCookie; the Workers types this suite checks against do not.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function callback(state: string, cookie: string): Request {
  return new Request(`${ORIGIN}/console/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
}

test("the start sets the console state cookie on Path=/console and sends GitHub the console callback", async () => {
  const e = env();
  const res = await startConsoleLogin(new Request(`${ORIGIN}/console`), e, "/console");
  const location = new URL(String(res.headers.get("Location")));
  assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/console/callback`);
  assert.equal(location.searchParams.get("scope"), "read:user");
  const setCookie = setCookies(res);
  assert.equal(setCookie.length, 1);
  assert.match(setCookie[0], /^capsid_console_state=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/console; Max-Age=600$/);
});

test("the admin completes the login: session cookie set, state cookie cleared, state consumed", async () => {
  const e = env();
  const { state, cookie } = await started(e);
  const exchanges = stubGithub("DrDustinEdwards");
  const res = await handleConsoleCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/console/json");
  assert.equal(exchanges[0]?.get("redirect_uri"), `${ORIGIN}/console/callback`);
  const cookies = setCookies(res);
  assert.equal(cookies.length, 2);
  assert.equal(cookies[1], "capsid_console_state=; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=0");
  const session = await readConsoleSession(
    new Request(`${ORIGIN}/console`, { headers: { Cookie: cookies[0].split(";")[0] } }),
    e,
    new Date()
  );
  assert.equal(session?.login, "DrDustinEdwards");
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

test("a GitHub account that is not the admin is refused and gets no session", async () => {
  const e = env();
  const { state, cookie } = await started(e);
  stubGithub("someone-else");
  const res = await handleConsoleCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 403);
  assert.match(await res.text(), /GitHub account "someone-else" is not its administrator/);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("an unset ADMIN_GITHUB_LOGIN admits nobody", async () => {
  const e = env({ ADMIN_GITHUB_LOGIN: undefined });
  const { state, cookie } = await started(e);
  stubGithub("DrDustinEdwards");
  const res = await handleConsoleCallback(callback(state, cookie), e, new Date());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Set-Cookie"), null);
});
