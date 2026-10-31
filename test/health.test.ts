import assert from "node:assert/strict";
import { test } from "node:test";
import { handleHealth } from "../src/health.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// /health is site-runtime's healthResponse: the store (D1 and the FTS probe) is the fail
// level, so only it can make a 503; the backup, the bindings and the task ledger warn and
// leave it 200, because health is about whether the store answers. The deploy gate's
// fields (sha, dirty, builtAt, store, schema_version) ride beside the family ones.
//
// That schema_version names the newest applied migration is asserted against a real
// D1 in test-integration/health.test.ts, which applies every file in migrations/.

function healthEnv(parts: Record<string, unknown>) {
  return fakeEnv({ BUILD_SHA: "abc123", BUILT_AT: "2026-09-07T00:00:00Z", ...parts });
}

type Body = { status: string; sha?: string; store?: { d1: string; fts: string }; backup?: { last_ok: string | null; age_hours: number | null; warning?: string }; checks: Array<{ name: string; status: string }> };

async function read(env: ReturnType<typeof healthEnv>): Promise<{ code: number; body: Body; byName: Record<string, string> }> {
  const resp = await handleHealth(env);
  const body = (await resp.json()) as Body;
  return { code: resp.status, body, byName: Object.fromEntries(body.checks.map((c) => [c.name, c.status])) };
}

test("a stale or unreadable backup and a failing binding warn, never fail", async () => {
  const stale = await read(
    healthEnv({
      DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
      APP_KV: fakeKv({ seed: { "backup:last-ok": new Date(Date.now() - 30 * 3600_000).toISOString() } }).kv,
      MEDIA: { head: async () => { throw new Error("R2 head exploded"); } } as unknown as R2Bucket,
    })
  );
  assert.equal(stale.code, 200, "a stale backup is a warning, not a health failure");
  assert.equal(stale.body.status, "warn");
  assert.match(String(stale.body.backup?.warning), /26h/);
  assert.equal(stale.byName.media, "warn");
  assert.deepEqual(stale.body.store, { d1: "ok", fts: "ok" });
  assert.equal(stale.body.sha, "abc123");

  // Date.parse gives NaN, and NaN > limit is false, so a naive check reads the stamp as fresh.
  const unparseable = await read(healthEnv({ DB: fakeD1({ migrations: ["0001_init.sql"] }).db, APP_KV: fakeKv({ seed: { "backup:last-ok": "not a date" } }).kv }));
  assert.equal(unparseable.code, 200);
  assert.equal(unparseable.byName.backup, "warn");
  assert.match(String(unparseable.body.backup?.warning), /not a parseable time/i);
});

test("a store whose FTS probe finds nothing fails with a 503, and the backup read failing does not mask it", async () => {
  const { code, body } = await read(healthEnv({ DB: fakeD1({ ftsHit: false, migrations: ["0001_init.sql"] }).db, APP_KV: fakeKv({ failGet: true }).kv }));
  assert.equal(code, 503);
  assert.equal(body.status, "fail");
  assert.notEqual(body.store?.fts, "ok");
  assert.ok(body.backup?.warning, "the KV failure is contained: backup carries a warning, it does not throw");
});
