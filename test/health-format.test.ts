import assert from "node:assert/strict";
import { test } from "node:test";
import { healthReport } from "../src/health.ts";
import { HEALTH_STATUSES, parseHealth } from "../src/health-format.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

test("parseHealth reads status and sha, and ignores extra fields", () => {
  assert.deepEqual(parseHealth(JSON.stringify({ status: "ok", sha: "deadbeef", db: "up", extra: 1 })), { status: "ok", sha: "deadbeef" });
  assert.deepEqual(parseHealth(JSON.stringify({ status: "down", sha: null })), { status: "down", sha: null });
});

test("parseHealth reads a body that does not follow the format as absent, never throwing", () => {
  const none = { status: null, sha: null };
  assert.deepEqual(parseHealth(null), none);
  assert.deepEqual(parseHealth(""), none);
  assert.deepEqual(parseHealth("<html>ok</html>"), none);
  assert.deepEqual(parseHealth("null"), none);
  assert.deepEqual(parseHealth("[]"), none);
  assert.deepEqual(parseHealth(JSON.stringify({ status: "fine", sha: 12345 })), none);
  assert.deepEqual(parseHealth(JSON.stringify({ status: "ok", sha: "" })), { status: "ok", sha: null });
  assert.equal(parseHealth(JSON.stringify({ sha: "a".repeat(64) })).sha?.length, 40);
});

test("every status the format names parses, and the count is the three the doc lists", () => {
  assert.equal(HEALTH_STATUSES.length, 3);
  for (const status of HEALTH_STATUSES) assert.equal(parseHealth(JSON.stringify({ status })).status, status);
});

test("capsid's own health report is in the standard format", async () => {
  const env = fakeEnv({ BUILD_SHA: "abc1234def", DB: fakeD1({ migrations: ["0001_init.sql"] }).db, APP_KV: fakeKv({}).kv });
  const parsed = parseHealth(JSON.stringify(await healthReport(env)));
  assert.notEqual(parsed.status, null, "the report's status is one of ok, degraded, down");
  assert.equal(parsed.sha, "abc1234def");
});
