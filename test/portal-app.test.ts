import assert from "node:assert/strict";
import { test } from "node:test";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { assetPath, DASHBOARD_CSP, handlePortalApp, HASHED_ASSET_CACHE, isNavigation } from "../src/portal-app.ts";
import { CONSENT_DIALOG_HEADERS } from "../src/headers.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// Capsid Portal's files behind the Portal gate (src/portal-app.ts), with a fake
// ASSETS binding that records what it was asked for. The same routes run through the
// whole Worker, with miniflare's real assets router, in
// test-integration/portal-app.test.ts.

const SECRET = "portal-app-test-cookie-secret";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const FILES: Record<string, { body: string; type: string }> = {
  "/": { body: "<!doctype html><title>Watch Floor</title>", type: "text/html" },
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
      return new Response(file.body, { status: 200, headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=0, must-revalidate" } });
    },
  };
  return { assets, asked };
}

function env(assets: unknown = fakeAssets().assets) {
  return fakeEnv({
    ASSETS: assets,
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
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, NOW)).split(";")[0];
  return new Request(`https://capsid.example${path}`, { headers: { ...headers, Cookie: cookie } });
}

test("PLANT: no file is fetched for a caller the Portal gate refuses", async () => {
  const { assets, asked } = fakeAssets();
  for (const path of ["/portal", "/portal/", "/portal/assets/app-abc123.js", "/portal/jobs"]) {
    const anonymous = await handlePortalApp(new Request(`https://capsid.example${path}`, { headers: { Accept: "text/html" } }), env(assets), NOW);
    assert.equal(anonymous.status, 302, `${path} served an anonymous reader`);
    const bearer = await handlePortalApp(new Request(`https://capsid.example${path}`, { headers: { Authorization: "Bearer capsid_x" } }), env(assets), NOW);
    assert.equal(bearer.status, 403, `${path} served a bearer`);
  }
  assert.deepEqual(asked, [], "the assets binding was asked for a file before the gate admitted anyone");
});

test("a signed-in administrator gets the app's page, uncached, under its own CSP", async () => {
  for (const path of ["/portal", "/portal/", "/portal/index.html"]) {
    const res = await handlePortalApp(await signed(path), env(), NOW);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /Watch Floor/);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Content-Security-Policy"), DASHBOARD_CSP);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  }
});

test("hashed files are cached privately and for a year; anything else is not cached", async () => {
  const js = await handlePortalApp(await signed("/portal/assets/app-abc123.js"), env(), NOW);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("Cache-Control"), HASHED_ASSET_CACHE);
  assert.equal(js.headers.get("Content-Security-Policy"), null, "the page's CSP is the page's, not every file's");
  const icon = await handlePortalApp(await signed("/portal/favicon.svg"), env(), NOW);
  assert.equal(icon.headers.get("Cache-Control"), "no-store");
});

test("an unknown path falls back to the page for a navigation only; a missing file stays a 404", async () => {
  const { assets, asked } = fakeAssets();
  const nav = await handlePortalApp(await signed("/portal/jobs/job_000000000001", { "Sec-Fetch-Mode": "navigate" }), env(assets), NOW);
  assert.equal(nav.status, 200);
  assert.match(await nav.text(), /Watch Floor/);
  assert.equal(nav.headers.get("Content-Security-Policy"), DASHBOARD_CSP);
  assert.deepEqual(asked, ["/jobs/job_000000000001", "/"]);

  const script = await handlePortalApp(await signed("/portal/assets/app-missing.js", { Accept: "*/*" }), env(), NOW);
  assert.equal(script.status, 404);
  assert.equal(script.headers.get("Cache-Control"), "no-store");
});

test("with no ASSETS binding the admin is told the dashboard is not deployed; nobody else learns it", async () => {
  const res = await handlePortalApp(await signed("/portal"), env(null), NOW);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not deployed/);
  const anonymous = await handlePortalApp(new Request("https://capsid.example/portal"), env(null), NOW);
  assert.equal(anonymous.status, 302);
});

test("a redirect from the assets router is put back under /portal", async () => {
  const assets = { fetch: async () => new Response(null, { status: 307, headers: { Location: "/about/" } }) };
  const res = await handlePortalApp(await signed("/portal/about"), env(assets), NOW);
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("Location"), "/portal/about/");
});

test("the app's paths map onto the assets directory, and navigations are told from fetches", () => {
  assert.equal(assetPath("/portal"), "/");
  assert.equal(assetPath("/portal/"), "/");
  assert.equal(assetPath("/portal/index.html"), "/");
  assert.equal(assetPath("/portal/assets/app-abc123.js"), "/assets/app-abc123.js");
  assert.equal(isNavigation(new Request("https://x.example", { headers: { "Sec-Fetch-Mode": "navigate" } })), true);
  assert.equal(isNavigation(new Request("https://x.example", { headers: { Accept: "text/html,application/xhtml+xml" } })), true);
  assert.equal(isNavigation(new Request("https://x.example", { headers: { Accept: "application/json", "Sec-Fetch-Mode": "cors" } })), false);
});

test("the Portal's CSP did not loosen the consent dialog's, and allows nothing inline", () => {
  assert.doesNotMatch(CONSENT_DIALOG_HEADERS["Content-Security-Policy"], /script-src|connect-src/);
  assert.doesNotMatch(DASHBOARD_CSP, /unsafe-inline|unsafe-eval|\*/);
});
