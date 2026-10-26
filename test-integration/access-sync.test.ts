import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// POST /ops/access-sync through the whole Worker, on the migrated database: the pinned group
// is read from access_sync_groups (migrations/0040) with the real statement. No Cloudflare
// call is made here: the test environment holds no CF_ACCESS_SYNC_TOKEN, so a found pin
// stops at the 503 that names the missing secret. Sample data only: namespace "sample".

const ORIGIN = "https://capsid.test";
const APP_KEY = "capsid_agent_" + "s".repeat(64);

async function sync(body: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/ops/access-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${APP_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /ops/access-sync", () => {
  beforeEach(async () => {
    const scopes = defaultScopes(["sample"]);
    scopes.grants = ["read", "write"];
    await env.DB.prepare("DELETE FROM access_sync_groups").run();
    await env.DB.prepare("DELETE FROM agents WHERE name = 'sample-app'").run();
    await env.DB.prepare(
      `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
       VALUES ('agent_sampleapp0001', 'sample-app', 'session', ?1, ?2, 'access:admin@example.com', '2026-10-10 00:00:00')`
    )
      .bind(await sha256Hex(APP_KEY), serializeScopes(scopes))
      .run();
  });

  it("refuses a namespace with no pinned group with a 409, reading the migrated table", async () => {
    const res = await sync({ namespace: "sample", members: ["rosa@example.com"] });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/no Access group is pinned for sample/);
  });

  it("finds the pinned group, then stops at the missing token without calling Cloudflare", async () => {
    await env.DB.prepare("INSERT INTO access_sync_groups (namespace, group_id, group_name, pinned_by) VALUES ('sample', '11111111-2222-3333-4444-555555555555', 'lab-people', 'access:admin@example.com')").run();
    const res = await sync({ namespace: "sample", members: ["rosa@example.com"] });
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/CF_ACCESS_SYNC_TOKEN is not set/);
  });

  it("refuses another app's namespace with a 403 before reading any pin", async () => {
    const res = await sync({ namespace: "carrel", members: ["rosa@example.com"] });
    expect(res.status).toBe(403);
  });
});
