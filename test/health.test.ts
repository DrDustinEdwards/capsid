import assert from "node:assert/strict";
import { test } from "node:test";
import { handleHealth } from "../src/health.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// Only the store can make /health a 503; the 503 itself and schema_version are test-integration/health.test.ts on a real D1.

function healthEnv(parts: Record<string, unknown>) {
  return fakeEnv({ BUILD_SHA: "abc123", ...parts });
}

type Body = {
  status: string;
  sha?: string;
  store?: { d1: string; fts: string };
  backup?: { last_ok: string | null; age_hours: number | null; warning?: string };
  checks: Array<{ name: string; status: string }>;
};

async function read(
  env: ReturnType<typeof healthEnv>,
): Promise<{ code: number; body: Body; byName: Record<string, string> }> {
  const resp = await handleHealth(env);
  const body = (await resp.json()) as Body;
  return {
    code: resp.status,
    body,
    byName: Object.fromEntries(body.checks.map((c) => [c.name, c.status])),
  };
}

test("a stale, unparseable or unreadable backup and a failing binding warn, never fail", async () => {
  const stale = await read(
    healthEnv({
      DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
      APP_KV: fakeKv({
        seed: { "backup:last-ok": new Date(Date.now() - 30 * 3600_000).toISOString() },
      }).kv,
      MEDIA: {
        head: async () => {
          throw new Error("R2 head exploded");
        },
      } as unknown as R2Bucket,
    }),
  );
  assert.equal(stale.code, 200, "a stale backup is a warning, not a health failure");
  assert.equal(stale.body.status, "warn");
  assert.match(String(stale.body.backup?.warning), /26h/);
  assert.equal(stale.byName.media, "warn");
  assert.deepEqual(stale.body.store, { d1: "ok", fts: "ok" });
  assert.equal(stale.body.sha, "abc123");

  // Date.parse gives NaN, and NaN > limit is false, so a naive check reads the stamp as fresh.
  const unparseable = await read(
    healthEnv({
      DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
      APP_KV: fakeKv({ seed: { "backup:last-ok": "not a date" } }).kv,
    }),
  );
  assert.equal(unparseable.code, 200);
  assert.equal(unparseable.byName.backup, "warn");
  assert.match(String(unparseable.body.backup?.warning), /not a parseable time/i);

  const unread = await read(
    healthEnv({
      DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
      APP_KV: fakeKv({ failGet: true }).kv,
    }),
  );
  assert.equal(unread.code, 200);
  assert.ok(unread.body.backup?.warning, "a KV failure is a backup warning, not a throw");
});
