import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { portalSessionCookie } from "../src/portal-auth";
import { HASHED_ASSET_CACHE } from "../src/portal-app";
import { PORTAL_HOST } from "../src/portal-host";

// Capsid Portal through the whole Worker: its pages (the tests' stand-in for the server-rendered
// build, test/fixtures/portal-pages.ts, which reads the feed as a real page does first) and its
// files, with miniflare's real ASSETS binding (vitest.config.ts, `assets`) holding the fake build
// in test-integration/fixtures/dashboard. SELF is the Worker's own default export, not the
// assets router in front of it, so what the router does is the deploy config's
// business (docs/portal.md, run_worker_first). A signed-in request is sent to the
// Worker's fetch with a cookie key, because the pool binds none (as oauth-flow.test.ts does).

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-cookie-key";
const PAGE_MARK = "<title>Capsid Portal</title>";
const SCRIPT_MARK = "watch-floor-fixture-script";
const NAV = { Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Mode": "navigate" };

async function signedFetch(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, { headers: { ...headers, Cookie: cookie }, redirect: "manual" });
  const response = await worker.fetch!(request as never, { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

describe("the Portal's pages and files", () => {
  it("the fixture is really served by the binding, so the refusals below are the gate and not a missing file", async () => {
    const direct = await env.ASSETS!.fetch("https://assets.invalid/assets/app-abc123.js");
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain(SCRIPT_MARK);
  });

  it("PLANT: a caller with no session gets the Access redirect, never a page", async () => {
    for (const path of ["/portal", "/portal/", "/portal/queue", "/portal/queue.data", "/portal/site.webmanifest"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: NAV, redirect: "manual" });
      expect(response.status, `${path} answered an anonymous caller`).toBe(302);
      expect(response.headers.get("Location") ?? "", `${path} redirected somewhere other than the Access sign-in`).toContain("sample.cloudflareaccess.com");
      expect(await response.text()).not.toContain(PAGE_MARK);
    }
  });

  it("a bearer gets 403", async () => {
    const response = await SELF.fetch(`${ORIGIN}/portal/`, { headers: { Authorization: "Bearer capsid_agent_x" } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(PAGE_MARK);
  });

  it("a signed-in administrator gets the page rendered with the Portal's own feed, no-store, its CSP carrying the page's nonce", async () => {
    const page = await signedFetch("/portal/queue", NAV);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(PAGE_MARK);
    expect(html, "the page is named without /portal").toContain('data-path="/queue"');
    expect(html, "the page's read reached the real feed route, behind the same gate").toContain('data-read="200"');
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Type") ?? "").toContain("text/html");
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.headers.get("Content-Security-Policy") ?? "").toContain(`'nonce-${nonce}'`);
    expect(page.headers.get("Content-Security-Policy") ?? "").not.toMatch(/unsafe-inline/);
    // The feed's first read minted the CSRF cookie, which the page passes on.
    expect(page.headers.get("Set-Cookie") ?? "").toContain("capsid_portal_csrf=");
  });

  it("the hashed files are public on the Portal host and cached for a year; elsewhere they are behind the gate", async () => {
    const script = await SELF.fetch(`https://${PORTAL_HOST}/assets/app-abc123.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain(SCRIPT_MARK);
    expect(script.headers.get("Cache-Control")).toBe(HASHED_ASSET_CACHE);
    const missing = await SELF.fetch(`https://${PORTAL_HOST}/assets/app-missing.js`);
    expect(missing.status).toBe(404);
    const elsewhere = await SELF.fetch(`${ORIGIN}/assets/app-abc123.js`, { redirect: "manual" });
    expect(await elsewhere.text()).not.toContain(SCRIPT_MARK);
  });

  it("/authorize and /portal/callback navigations still reach the Worker, not a page", async () => {
    const authorize = await SELF.fetch(`${ORIGIN}/authorize`, { headers: NAV, redirect: "manual" });
    const authorizeBody = await authorize.text();
    expect(authorizeBody).not.toContain(PAGE_MARK);
    expect(authorizeBody, "the Worker's own refusal of an empty authorization request").toMatch(/client_id is required/);

    const callback = await SELF.fetch(`${ORIGIN}/portal/callback`, { headers: NAV, redirect: "manual" });
    expect(callback.status, "the Portal callback with no state is refused by the Worker").toBeGreaterThanOrEqual(400);
    expect(await callback.text()).not.toContain(PAGE_MARK);
  });
});
