import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { completeAccessLogin, startAccessLogin, type LoginFlow } from "../src/access-login.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The state cookie that binds a sign-in to the browser that started it
// (src/access-login.ts). The round trip through Access is test-integration/oauth-round-trip.test.ts.

const ORIGIN = "https://capsid.example.com";
const FLOW: LoginFlow = { callbackPath: "/callback", stateCookie: "sample_state", cookiePath: "/", kvPrefix: "sample:state:", restartHint: "Start again." };

function env() {
  const kv = fakeKv();
  return {
    kv,
    env: fakeEnv({
      OAUTH_KV: kv.kv,
      ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.example.com",
      ACCESS_SAAS_CLIENT_ID: "sample-client",
      ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
    }),
  };
}

async function started(e: ReturnType<typeof env>["env"]) {
  const response = await startAccessLogin(new Request(`${ORIGIN}/authorize`), e, FLOW, "stored");
  const state = new URL(String(response.headers.get("location"))).searchParams.get("state") ?? "";
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0].slice(`${FLOW.stateCookie}=`.length);
  return { state, cookie };
}

const callback = (state: string, cookie: string) =>
  new Request(`${ORIGIN}${FLOW.callbackPath}?code=access-code&state=${state}`, { headers: { Cookie: `${FLOW.stateCookie}=${cookie}` } });

test("PLANT: the state cookie cannot be computed from the state in the callback URL", async () => {
  const { env: e } = env();
  const { state, cookie } = await started(e);
  assert.notEqual(cookie, await sha256Hex(state), "the cookie is the state's digest, which anyone holding the URL can compute");
  const forged = await completeAccessLogin(callback(state, await sha256Hex(state)), e, FLOW, (s) => s);
  assert.equal(forged.ok, false);
  assert.equal(!forged.ok && forged.response.status, 403);
  assert.match(!forged.ok ? await forged.response.text() : "", /this browser did not start the flow/);
});

test("the browser that started the sign-in passes the state check and reaches the token exchange", async () => {
  const { env: e } = env();
  const { state, cookie } = await started(e);
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const result = await completeAccessLogin(callback(state, cookie), e, FLOW, (s) => s);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? await result.response.text() : "", /token exchange failed \(500\)/);
    assert.equal(asked.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});
