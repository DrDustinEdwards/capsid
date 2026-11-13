import assert from "node:assert/strict";
import { test } from "node:test";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { dashboardCsp } from "../src/dashboard-csp.ts";
import { handlePortalApp, HASHED_ASSET_CACHE, portalAsset } from "../src/portal-app.ts";
import { withSecurityHeaders } from "../src/security-headers.ts";
import { MCP_HOST } from "../src/mcp-host.ts";
import { fakeEnv, fakeKv, withPortalSessionEnds } from "./fakes.ts";

// Capsid Portal behind its gate (src/portal-app.ts): its server-rendered pages (the tests'
// stand-in, test/fixtures/portal-pages.ts) and its files, with a fake ASSETS binding that
// records what it was asked for and a fake API that records what the page read. The same routes
// run through the whole Worker, with miniflare's real assets router, in
// test-integration/portal-app.test.ts.

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
      // The router's own caching header, which the handler must replace.
      return new Response(file.body, {
        status: 200,
        headers: {
          "Content-Type": file.type,
          "Cache-Control": "public, max-age=0, must-revalidate",
        },
      });
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

async function signed(path: string, headers: Record<string, string> = {}): Promise<Request> {
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, NOW)).split(
    ";",
  )[0];
  return new Request(`https://capsid.example${path}`, { headers: { ...headers, Cookie: cookie } });
}

// The Portal's API as the page reads it: what it was asked, answered with a feed that mints the
// CSRF cookie, as src/ops-feed.ts does on a session's first read.
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

test("a signed-in administrator gets the page rendered with its reads, uncached and untransformed, its CSP carrying the page's nonce", async () => {
  const reads = fakeApi();
  // As index.ts serves it: through the header layer.
  const res = withSecurityHeaders(
    await handlePortalApp(await signed("/portal/queue"), env(), reads.api, NOW),
    new Request(`https://${MCP_HOST}/portal/queue`),
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(
    html,
    /data-path="\/queue"/,
    "the page is named as the browser names it, without /portal",
  );
  assert.equal(res.headers.get("Cache-Control"), "private, no-store, no-transform");
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce, "the page's script carries a nonce");
  assert.ok(
    res.headers.get("Content-Security-Policy")?.includes(`'nonce-${nonce}'`),
    "the policy names the page's nonce",
  );
  // The read went to the Portal's own API with the visitor's session, and its cookie reached the browser.
  assert.equal(reads.asked[0]?.path, "/portal/api/ops");
  assert.match(reads.asked[0]?.cookie ?? "", /capsid_portal/);
  assert.match(res.headers.get("Set-Cookie") ?? "", /capsid_portal_csrf=fresh/);
});

test("each page gets its own nonce", async () => {
  const one = dashboardCsp();
  const two = dashboardCsp();
  assert.notEqual(one.nonce, two.nonce);
  assert.doesNotMatch(one.policy, /unsafe-inline|unsafe-eval|\*/);
  assert.ok(one.policy.includes(`'nonce-${one.nonce}'`));
});

test("the hashed files are public on the Portal host and cached for a year; the other files stay behind the gate, uncached", async () => {
  const js = await portalAsset(
    new Request("https://portal.dustinedwards.info/assets/app-abc123.js"),
    env(),
  );
  assert.equal(js?.status, 200);
  assert.equal(js?.headers.get("Cache-Control"), HASHED_ASSET_CACHE);
  assert.equal(
    js?.headers.get("Content-Security-Policy"),
    null,
    "the page's CSP is the page's, not every file's",
  );
  assert.equal(
    await portalAsset(new Request("https://portal.dustinedwards.info/favicon.svg"), env()),
    null,
    "only the hashed files are public",
  );
  const icon = await handlePortalApp(
    await signed("/portal/favicon.svg"),
    env(),
    fakeApi().api,
    NOW,
  );
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("Cache-Control"), "no-store");
  const missing = await handlePortalApp(
    await signed("/portal/missing.png"),
    env(),
    fakeApi().api,
    NOW,
  );
  assert.equal(missing.status, 404);
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
