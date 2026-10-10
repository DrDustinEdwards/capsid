import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_SHARED_CODE_PATH } from "../src/portal-packages";
import { SHARED_CODE_CACHE_KEY } from "../src/shared-code";
import type { SharedCodeView } from "../src/ops-types";

// The Shared code view's route through the Worker, against the D1 the migrations build:
// the six seeded packages are read from configuration, and an app or a tag list that
// cannot be read is said, never counted as up to date. No GitHub is reachable here, so
// every read fails, which is the case this test is for.

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-cookie-key";

async function signedGet(path: string): Promise<Response> {
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const ctx = createExecutionContext();
  const response = await worker.fetch!(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie }, redirect: "manual" }) as never, { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

beforeEach(async () => {
  await env.APP_KV.delete(SHARED_CODE_CACHE_KEY);
});

describe("GET /portal/api/shared-code", () => {
  it("reads the packages from configuration, and says each app and tag list it could not read", async () => {
    const response = await signedGet(PORTAL_SHARED_CODE_PATH);
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as SharedCodeView;
    expect(view.configured).toBe(true);
    expect(view.packages.map((p) => p.name).sort()).toEqual(["Capsomer", "d1-dump", "devkit", "Prelum", "site-api", "site-runtime"].sort());
    const sites = await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_sites").first<{ n: number }>();
    expect(view.apps_read + view.apps_failed.length, "every configured site was tried").toBe(sites!.n);
    for (const pkg of view.packages) {
      expect(pkg.latest).toBeNull();
      expect(pkg.tags_error, `${pkg.name} has no tags and no reason`).toBeTruthy();
    }
    expect(view.packages.find((p) => p.name === "site-runtime")?.local_copies).toEqual([{ namespace: "dustinedwards", path: "packages/security-headers", present: null }]);
  });

  it("says the table is missing rather than showing nothing", async () => {
    await env.DB.prepare("ALTER TABLE shared_packages RENAME TO shared_packages_away").run();
    try {
      const view = (await (await signedGet(PORTAL_SHARED_CODE_PATH)).json()) as SharedCodeView;
      expect(view.configured).toBe(false);
      expect(view.error).toMatch(/0036_shared_packages\.sql/);
    } finally {
      await env.DB.prepare("ALTER TABLE shared_packages_away RENAME TO shared_packages").run();
    }
  });
});
