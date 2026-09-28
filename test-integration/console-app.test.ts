import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { consoleSessionCookie } from "../src/console-auth";
import { DASHBOARD_CSP, HASHED_ASSET_CACHE } from "../src/console-app";

// The Watch Floor app's files through the whole Worker, with miniflare's real ASSETS
// binding (vitest.config.ts, `assets`) holding the fake build in
// test-integration/fixtures/dashboard. SELF is the Worker's own default export, not the
// assets router in front of it, so what the router does is the deploy config's
// business (docs/console.md, run_worker_first). A signed-in request is sent to the
// Worker's fetch with a cookie key, because the pool binds none (as oauth-flow.test.ts does).

const ORIGIN = "https://capsid.test";
const SECRET = "integration-console-cookie-key";
const INDEX_MARK = "watch-floor-fixture-index";
const SCRIPT_MARK = "watch-floor-fixture-script";
const NAV = { Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Mode": "navigate" };

async function signedFetch(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const cookie = (await consoleSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${path}`, { headers: { ...headers, Cookie: cookie }, redirect: "manual" });
  const response = await worker.fetch!(request as never, { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

describe("/console/app through the assets router", () => {
  it("the fixture is really served by the binding, so the refusals below are the gate and not a missing file", async () => {
    const direct = await env.ASSETS!.fetch("https://assets.invalid/assets/app-abc123.js");
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain(SCRIPT_MARK);
  });

  it("PLANT: a caller with no session gets the Access redirect, never the file", async () => {
    for (const path of ["/console/app", "/console/app/", "/console/app/index.html", "/console/app/assets/app-abc123.js", "/console/app/jobs"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: NAV, redirect: "manual" });
      expect(response.status, `${path} answered an anonymous caller`).toBe(302);
      expect(response.headers.get("Location") ?? "", `${path} redirected somewhere other than the Access sign-in`).toContain("sample.cloudflareaccess.com");
      const body = await response.text();
      expect(body).not.toContain(INDEX_MARK);
      expect(body).not.toContain(SCRIPT_MARK);
    }
  });

  it("a bearer gets 403", async () => {
    const response = await SELF.fetch(`${ORIGIN}/console/app/assets/app-abc123.js`, { headers: { Authorization: "Bearer capsid_agent_x" } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(SCRIPT_MARK);
  });

  it("the Worker serves none of the build's files at the origin's root", async () => {
    // The Worker's half only. Whether the assets router serves these paths ahead of the
    // Worker is decided by run_worker_first in the deploy config, which this pool
    // cannot exercise: SELF is the Worker itself (vitest.config.ts, `assets`).
    for (const path of ["/index.html", "/assets/app-abc123.js", "/"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: NAV, redirect: "manual" });
      const body = await response.text();
      expect(body, `${path} was served by the assets router ahead of the Worker`).not.toContain(INDEX_MARK);
      expect(body, `${path} was served by the assets router ahead of the Worker`).not.toContain(SCRIPT_MARK);
    }
  });

  it("a signed-in administrator gets the page with no-store and the dashboard CSP, and a hashed file cached for a year", async () => {
    const page = await signedFetch("/console/app/", NAV);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(INDEX_MARK);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toBe(DASHBOARD_CSP);
    expect(page.headers.get("Content-Type") ?? "").toContain("text/html");

    const script = await signedFetch("/console/app/assets/app-abc123.js", { Accept: "*/*" });
    expect(script.status).toBe(200);
    expect(await script.text()).toContain(SCRIPT_MARK);
    expect(script.headers.get("Cache-Control")).toBe(HASHED_ASSET_CACHE);
  });

  it("an unknown navigation gets the page; an unknown file stays a 404", async () => {
    const nav = await signedFetch("/console/app/jobs/job_000000000001", NAV);
    expect(nav.status).toBe(200);
    expect(await nav.text()).toContain(INDEX_MARK);
    expect(nav.headers.get("Content-Security-Policy")).toBe(DASHBOARD_CSP);

    const missing = await signedFetch("/console/app/assets/app-missing.js", { Accept: "*/*" });
    expect(missing.status).toBe(404);
  });

  it("/authorize and /console/callback navigations still reach the Worker, not the app's page", async () => {
    const authorize = await SELF.fetch(`${ORIGIN}/authorize`, { headers: NAV, redirect: "manual" });
    const authorizeBody = await authorize.text();
    expect(authorizeBody).not.toContain(INDEX_MARK);
    expect(authorizeBody, "the Worker's own refusal of an empty authorization request").toMatch(/invalid authorization request/);

    const callback = await SELF.fetch(`${ORIGIN}/console/callback`, { headers: NAV, redirect: "manual" });
    expect(callback.status, "the console callback with no state is refused by the Worker").toBeGreaterThanOrEqual(400);
    expect(await callback.text()).not.toContain(INDEX_MARK);
  });
});
