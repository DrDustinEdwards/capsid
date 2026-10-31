import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { COMPLETENESS_CACHE_KEY } from "../src/completeness";
import type { CompletenessView } from "../src/ops-types/feed";
import { portalSessionCookie } from "../src/portal-auth";
import { PORTAL_COMPLETENESS_PATH } from "../src/portal-packages";

// The Completeness view's route through the Worker. No GitHub is reachable here, so the
// board cannot be read, and the view must say so rather than show an empty board as if
// nothing were missing; a failed read is never cached.

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-cookie-key";

describe("GET /portal/api/completeness", () => {
  it("says why the board could not be read, and keeps no answer", async () => {
    const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
    const ctx = createExecutionContext();
    const response = (await worker.fetch!(new Request(`${ORIGIN}${PORTAL_COMPLETENESS_PATH}`, { headers: { Cookie: cookie }, redirect: "manual" }) as never, { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never, ctx)) as unknown as Response;
    await waitOnExecutionContext(ctx);
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as CompletenessView;
    expect(view.error).toMatch(/board\.json/);
    expect(view.areas).toEqual([]);
    expect(view.finished).toBe(false);
    expect(await env.APP_KV.get(COMPLETENESS_CACHE_KEY)).toBeNull();
  });
});
