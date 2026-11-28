import assert from "node:assert/strict";
import { test } from "node:test";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { dashboardCsp } from "../src/dashboard-csp.ts";
import { handlePortalApp } from "../src/portal-app.ts";
import { fakeEnv, fakeKv, withPortalSessionEnds } from "./fakes.ts";

// The signed-in page and the hashed files run through the whole Worker in test-integration/portal-app.test.ts.

const SECRET = "portal-app-test-cookie-secret";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const FILES: Record<string, { body: string; type: string }> = {
  "/assets/app-abc123.js": { body: "console.log('app')", type: "text/javascript" },
  "/favicon.svg": { body: "<svg/>", type: "image/svg+xml" },
};

function fakeAssets() {
  const asked: string[] = [];
  const assets = {
    fetch: async (input: Request) => {
      const path = new URL(input.url).pathname;
      asked.push(path);
      const file = FILES[path];
      if (!file) return new Response("", { status: 404 });
      return new Response(file.body, { status: 200, headers: { "Content-Type": file.type } });
    },
  };
  return { assets, asked };
}

function env(assets: unknown = fakeAssets().assets) {
  return fakeEnv({
    ASSETS: assets,
    DB: withPortalSessionEnds().db,
    APP_KV: fakeKv().kv,
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_EMAIL: "admin@example.com",
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
  });
}

async function signed(path: string): Promise<Request> {
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, NOW)).split(
    ";",
  )[0];
  return new Request(`https://capsid.example${path}`, { headers: { Cookie: cookie } });
}

function fakeApi() {
  const asked: Array<{ path: string; cookie: string | null }> = [];
  const api = async (request: Request) => {
    asked.push({ path: new URL(request.url).pathname, cookie: request.headers.get("Cookie") });
    return new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "capsid_portal_csrf=fresh; Path=/portal; Secure; HttpOnly",
      },
    });
  };
  return { api, asked };
}

test("PLANT: nothing is rendered, read or fetched for a caller the Portal gate refuses", async () => {
  const { assets, asked } = fakeAssets();
  const reads = fakeApi();
  for (const path of ["/portal", "/portal/", "/portal/favicon.svg", "/portal/queue"]) {
    const anonymous = await handlePortalApp(
      new Request(`https://capsid.example${path}`, { headers: { Accept: "text/html" } }),
      env(assets),
      reads.api,
      NOW,
    );
    assert.equal(anonymous.status, 302, `${path} served an anonymous reader`);
    const bearer = await handlePortalApp(
      new Request(`https://capsid.example${path}`, {
        headers: { Authorization: "Bearer capsid_x" },
      }),
      env(assets),
      reads.api,
      NOW,
    );
    assert.equal(bearer.status, 403, `${path} served a bearer`);
  }
  assert.deepEqual(
    asked,
    [],
    "the assets binding was asked for a file before the gate admitted anyone",
  );
  assert.deepEqual(reads.asked, [], "a page read the API before the gate admitted anyone");
});

test("each page gets its own nonce", async () => {
  const one = dashboardCsp();
  const two = dashboardCsp();
  assert.notEqual(one.nonce, two.nonce);
  assert.doesNotMatch(one.policy, /unsafe-inline|unsafe-eval|\*/);
  assert.ok(one.policy.includes(`'nonce-${one.nonce}'`));
});

test("with no ASSETS binding the admin is told the dashboard is not deployed; nobody else learns it", async () => {
  const res = await handlePortalApp(await signed("/portal"), env(null), fakeApi().api, NOW);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not deployed/);
  const anonymous = await handlePortalApp(
    new Request("https://capsid.example/portal"),
    env(null),
    fakeApi().api,
    NOW,
  );
  assert.equal(anonymous.status, 302);
});
