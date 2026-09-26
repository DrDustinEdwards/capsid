import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKUP_STALE_HOURS as HEALTH_THRESHOLD } from "../src/health.ts";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: the
// live gate runs with no npm ci so it can run even when install is broken.
import { BACKUP_STALE_HOURS, checkBackupFreshness } from "../scripts/freshness-lib.mjs";

// The backup freshness gate, which reads /health's backup.last_ok. These drive the
// check directly, because verify-live.mjs runs on import.

const NOW = Date.parse("2026-09-08T12:00:00Z");
const health = (lastOk: string | null, ageHours?: number) => ({
  status: "ok",
  backup: { last_ok: lastOk, age_hours: ageHours ?? null },
});

test("the gate's threshold is the same number /health warns at", () => {
  // A gate that failed at a different age than /health warns at would report a
  // different fact than the one it names.
  assert.equal(BACKUP_STALE_HOURS, HEALTH_THRESHOLD);
});

test("a backup from three hours ago is fresh", () => {
  const r = checkBackupFreshness(health("2026-09-08T09:00:00Z", 3), { assert: true, now: NOW });
  assert.equal(r.outcome, "fresh");
  assert.equal(r.passed, true);
  assert.match(r.detail, /3h ago/);
});

test("a backup from 27 hours ago FAILS, and names the age", () => {
  const r = checkBackupFreshness(health("2026-09-07T09:00:00Z", 27), { assert: true, now: NOW });
  assert.equal(r.outcome, "stale");
  assert.equal(r.passed, false);
  assert.match(r.detail, /27h ago, over the 26h threshold/);
});

test("25.9 hours passes and 26.1 fails: the boundary is where it says it is", () => {
  const at = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
  assert.equal(checkBackupFreshness(health(at(25.9)), { assert: true, now: NOW }).passed, true);
  assert.equal(checkBackupFreshness(health(at(26.1)), { assert: true, now: NOW }).passed, false);
});

test("NO STAMP AT ALL FAILS CLOSED, which is the condition measured on live", () => {
  const r = checkBackupFreshness(health(null), { assert: true, now: NOW });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.passed, false);
  assert.match(r.detail, /no clean backup has completed/);
  // A /health with no backup field is the same verdict, not a crash or a pass.
  const missing = checkBackupFreshness({ status: "ok" }, { assert: true, now: NOW });
  assert.equal(missing.passed, false);
  assert.equal(checkBackupFreshness(null, { assert: true, now: NOW }).passed, false);
});

test("an unparseable stamp is a failure, not a NaN that compares false", () => {
  const r = checkBackupFreshness(health("yesterday-ish"), { assert: true, now: NOW });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.passed, false);
});

test("a stamp in the future FAILS: a negative age is not fresh", () => {
  // now - last_ok is negative here, which would pass a plain "under 26h" test.
  const r = checkBackupFreshness(health("2026-09-09T12:00:00Z"), { assert: true, now: NOW });
  assert.equal(r.passed, false);
  assert.equal(r.outcome, "unknown");
  assert.match(r.detail, /24h in the future/);
  // Inside the one hour clock skew tolerance it still passes.
  assert.equal(checkBackupFreshness(health("2026-09-08T12:30:00Z"), { assert: true, now: NOW }).passed, true);
});

test("a non-scheduled run SKIPS, says so, and never reports a pass as an assertion", () => {
  const r = checkBackupFreshness(health(null), { assert: false, now: NOW });
  assert.equal(r.outcome, "skipped");
  assert.equal(r.passed, true);
  assert.match(r.detail, /SKIPPED/);
  assert.match(r.detail, /asserts nothing/);
});

test("the age is computed here, and a clock disagreement is reported", () => {
  // The Worker reports 2h for a stamp 27h old; the gate must fail on its own
  // arithmetic rather than the reported number.
  const r = checkBackupFreshness(health("2026-09-07T09:00:00Z", 2), { assert: true, now: NOW });
  assert.equal(r.passed, false);
  assert.match(r.detail, /DISAGREEING/);
});

test("verify-live wires the gate, and CI turns the assertion on for scheduled runs", () => {
  const verify = readFileSync(join(import.meta.dirname, "..", "scripts", "verify-live.mjs"), "utf8");
  assert.match(verify, /checkBackupFreshness/, "verify-live does not run the freshness check");
  assert.match(verify, /ASSERT_BACKUP_FRESH/, "verify-live has no way to be told this is a scheduled run");
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const line = ci.split("\n").find((l) => l.includes("ASSERT_BACKUP_FRESH")) ?? "";
  assert.match(line, /schedule/, "CI never sets ASSERT_BACKUP_FRESH on the scheduled run, so the gate always skips");
});
