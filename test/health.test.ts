import assert from "node:assert/strict";
import { test } from "node:test";
import { handleHealth } from "../src/health.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// GROUP 4 (deploy pipeline). /health gained two operational facts: the schema
// version it is running against, and the age of the last successful backup. Both
// are informational: a stale backup or an unreadable migration name is a WARNING,
// never a reason to report degraded, because health is about whether the store
// answers, and these two are about whether the operator should look.
//
// That schema_version names the newest applied migration is asserted against a real
// D1 in test-integration/health.test.ts, which applies every file in migrations/.

function healthEnv(parts: Record<string, unknown>) {
  return fakeEnv({
    BUILD_SHA: "abc123",
    BUILT_AT: "2026-09-07T00:00:00Z",
    ...parts,
  });
}

async function bodyOf(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json()) as Record<string, unknown>;
}

test("a fresh backup carries an age and no warning, and does not degrade health", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": new Date(Date.now() - 2 * 3600_000).toISOString() } }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 200);
  assert.equal(body.status, "ok");
  const backup = body.backup as { age_hours: number; warning?: string };
  assert.ok(backup.age_hours >= 1.9 && backup.age_hours <= 2.1, `age_hours was ${backup.age_hours}`);
  assert.equal(backup.warning, undefined);
});

test("a backup older than 26 hours warns, but health stays ok", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": new Date(Date.now() - 30 * 3600_000).toISOString() } }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 200, "a stale backup is a warning, not a health failure");
  assert.equal(body.status, "ok");
  const backup = body.backup as { warning?: string };
  assert.match(String(backup.warning), /26h/);
});

test("a missing backup stamp warns rather than throwing", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({}).kv,
  });
  const body = await bodyOf(await handleHealth(env));
  const backup = body.backup as { last_ok: string | null; warning?: string };
  assert.equal(backup.last_ok, null);
  assert.match(String(backup.warning), /no successful backup/i);
});

test("an unparseable backup stamp warns instead of reporting no warning", async () => {
  // Date.parse gives NaN, and NaN > limit is false, so before this the stamp read as
  // fresh: no warning and an age_hours of null.
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": "not a date" } }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 200, "an unreadable stamp is a warning, not a health failure");
  const backup = body.backup as { last_ok: string | null; age_hours: number | null; warning?: string };
  assert.equal(backup.last_ok, "not a date");
  assert.equal(backup.age_hours, null);
  assert.match(String(backup.warning), /not a parseable time/i);
});

// A bucket stub with only the call the probe makes.
function media(head: () => Promise<unknown>) {
  return { head } as unknown as R2Bucket;
}

test("MEDIA and APP_KV are probed and reported as fields", async () => {
  const env = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ seed: { "backup:last-ok": new Date().toISOString() } }).kv,
    MEDIA: media(async () => null),
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 200);
  assert.deepEqual(body.bindings, { media: "ok", app_kv: "ok" });
});

test("a missing or failing MEDIA or APP_KV is reported, and does not change status", async () => {
  // Status stays about the store (D1 and FTS): the live gate polls status until it
  // reads ok, and these two bindings are reported for a person or the watcher to read.
  const unbound = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ failGet: true }).kv,
  });
  const a = await handleHealth(unbound);
  const aBody = await bodyOf(a);
  assert.equal(a.status, 200);
  assert.equal(aBody.status, "ok");
  const aBindings = aBody.bindings as { media: string; app_kv: string };
  assert.equal(aBindings.media, "unbound");
  assert.match(aBindings.app_kv, /^error: KV get exploded/);

  const failing = healthEnv({
    DB: fakeD1({ migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({}).kv,
    MEDIA: media(async () => {
      throw new Error("R2 head exploded");
    }),
  });
  const bBody = await bodyOf(await handleHealth(failing));
  const bBindings = bBody.bindings as { media: string; app_kv: string };
  assert.match(bBindings.media, /^error: R2 head exploded/);
  assert.equal(bBindings.app_kv, "ok");
});

test("a degraded store still reports, and the backup read failing does not mask it", async () => {
  const env = healthEnv({
    DB: fakeD1({ ftsHit: false, migrations: ["0001_init.sql"] }).db,
    APP_KV: fakeKv({ failGet: true }).kv,
  });
  const resp = await handleHealth(env);
  const body = await bodyOf(resp);
  assert.equal(resp.status, 503);
  assert.equal(body.status, "degraded");
  // The KV failure is contained: backup carries a warning, it does not throw.
  assert.ok((body.backup as { warning?: string }).warning);
});
