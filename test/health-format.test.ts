import assert from "node:assert/strict";
import { test } from "node:test";
import { healthReport } from "../src/health.ts";
import { parseHealth } from "../src/health-format.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

test("parseHealth reads the family format, the older ok bodies and Capsid's own the same way", () => {
  const read = (body: unknown) => parseHealth(JSON.stringify(body));
  assert.deepEqual(read({ status: "pass", ok: true, sha: "deadbeef", checks: [{ name: "db", status: "pass" }] }), { status: "ok", sha: "deadbeef", problem: null });
  assert.deepEqual(read({ status: "warn", ok: true, checks: [{ name: "db", status: "pass" }, { name: "backup", status: "warn", detail: "old" }] }), { status: "degraded", sha: null, problem: "backup" });
  assert.equal(read({ status: "fail", ok: false, checks: [{ name: "db", status: "fail" }] }).status, "down");
  // A 200 that admits a problem is not healthy: ok false, or a backup warning under ok.
  assert.deepEqual(read({ ok: false, checks: [{ name: "content-drift", ok: false }] }), { status: "degraded", sha: null, problem: "content-drift" });
  assert.deepEqual(read({ ok: false }), { status: "degraded", sha: null, problem: "ok: false" });
  assert.deepEqual(read({ status: "ok", backup: { warning: "last successful backup was 38.4h ago" } }), { status: "degraded", sha: null, problem: "backup: last successful backup was 38.4h ago" });
  assert.equal(read({ ok: true, db: "up", backup: { age_hours: 20 } }).status, "ok");
  assert.equal(read({ status: "down" }).status, "down");
});

test("parseHealth reads a body that does not follow the format as absent, never throwing", () => {
  const none = { status: null, sha: null, problem: null };
  assert.deepEqual(parseHealth(null), none);
  assert.deepEqual(parseHealth(""), none);
  assert.deepEqual(parseHealth("<html>ok</html>"), none);
  assert.deepEqual(parseHealth("null"), none);
  assert.deepEqual(parseHealth("[]"), none);
  assert.deepEqual(parseHealth(JSON.stringify({ status: "fine", sha: 12345 })), none);
  assert.equal(parseHealth(JSON.stringify({ status: "ok", sha: "" })).sha, null);
  assert.equal(parseHealth(JSON.stringify({ sha: "a".repeat(64) })).sha?.length, 40);
});

test("capsid's own health report is in the standard format", async () => {
  const env = fakeEnv({ BUILD_SHA: "abc1234def", DB: fakeD1({ migrations: ["0001_init.sql"] }).db, APP_KV: fakeKv({}).kv });
  const parsed = parseHealth(JSON.stringify(await healthReport(env)));
  assert.notEqual(parsed.status, null, "the report's status is one of ok, degraded, down");
  assert.equal(parsed.sha, "abc1234def");
});
