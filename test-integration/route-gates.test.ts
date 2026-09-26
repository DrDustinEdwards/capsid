import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { ROUTE_GRANTS, UNGATED_ROUTES } from "../src/scope";

// Every route goes through the one enforcement point, driven through the whole
// Worker: each request goes through SELF.fetch with the credential a caller would
// present.

const ORIGIN = "https://capsid.test";
const DRIVER_KEY = "capsid_agent_" + "d".repeat(64);

async function backupAs(bearer: string | null): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/ops/backup`, {
    method: "POST",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

async function dumpCount(): Promise<number> {
  return (await env.MEDIA.list({ prefix: "backups/" })).objects.length;
}

beforeEach(async () => {
  // A driver minted for one namespace with the write grant.
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  await env.DB.prepare("DELETE FROM agents").run();
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES ('agent_driver000001', 'capsid-driver', 'driver', ?1, ?2, 'github:dustin', '2026-09-11 00:00:00')`
  )
    .bind(await sha256Hex(DRIVER_KEY), serializeScopes(scopes))
    .run();
});

describe("/ops/backup", () => {
  it("REPRODUCTION: refuses a one-namespace driver that holds write with 403, and runs nothing", async () => {
    const before = await dumpCount();
    const response = await backupAs(DRIVER_KEY);
    expect(response.status, "a resolved caller that is refused should get 403, not 401").toBe(403);
    const text = await response.text();
    expect(text).toMatch(/admin only/);
    expect(text, "the refusal does not say why a backup is admin work").toMatch(/every namespace/);
    expect(await dumpCount(), "a refused caller started a backup").toBe(before);
  });

  it("admits the legacy write-grant operator key, which is the admin, and the backup runs", async () => {
    const before = await dumpCount();
    const response = await backupAs(env.TEST_OPERATOR_KEYS.write);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { ran?: boolean }).ran).toBe(true);
    expect(await dumpCount()).toBeGreaterThan(before);
  });

  it("refuses the legacy read-only operator key with 403", async () => {
    const response = await backupAs(env.TEST_OPERATOR_KEYS.read);
    expect(response.status).toBe(403);
  });

  it("answers 401 to a request with no credential, so a client knows to send one", async () => {
    const response = await backupAs(null);
    expect(response.status).toBe(401);
  });
});

describe("the route tables are a statement about the Worker that serves them", () => {
  const isFallback = async (r: Response) => r.status === 404 && (await r.clone().text()) === "not found";

  it("every path in ROUTE_GRANTS and UNGATED_ROUTES is served by some method, so no entry is stale", async () => {
    const paths = [...Object.keys(ROUTE_GRANTS), ...Object.keys(UNGATED_ROUTES)];
    expect(paths.length, "the tables are empty, so this proves nothing").toBeGreaterThan(0);
    // The fallback is what an unserved path gets, measured rather than assumed.
    expect(await isFallback(await SELF.fetch(`${ORIGIN}/not-a-route`))).toBe(true);
    for (const path of paths) {
      const get = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      const post = await SELF.fetch(`${ORIGIN}${path}`, { method: "POST", redirect: "manual", body: "" });
      const served = !(await isFallback(get)) || !(await isFallback(post));
      expect(served, `src/scope.ts names route ${path}, which the Worker does not serve`).toBe(true);
    }
  });

  it("every gated route refuses a non-admin driver with 403, so each one asks routeRefusal", async () => {
    const gated = Object.keys(ROUTE_GRANTS);
    expect(gated.length, "ROUTE_GRANTS is empty, so this proves nothing").toBeGreaterThan(0);
    for (const path of gated) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { Authorization: `Bearer ${DRIVER_KEY}` } });
      expect(response.status, `${path} is in ROUTE_GRANTS and served a one-namespace driver`).toBe(403);
    }
  });
});
