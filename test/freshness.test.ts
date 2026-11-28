import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKUP_STALE_HOURS as HEALTH_THRESHOLD } from "../src/health.ts";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: the
// live gate runs with no npm ci so it can run even when install is broken.
import { BACKUP_STALE_HOURS, checkBackupFreshness } from "../scripts/freshness-lib.mjs";

// The backup freshness gate over /health's backup.last_ok, driven directly because verify-live.mjs runs on import.

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

test("25.9 hours passes and 26.1 fails: the boundary is where it says it is", () => {
  const at = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
  assert.equal(checkBackupFreshness(health(at(25.9)), { assert: true, now: NOW }).passed, true);
  assert.equal(checkBackupFreshness(health(at(26.1)), { assert: true, now: NOW }).passed, false);
});

test("no stamp, an unparseable one, or one in the future fails closed as unknown", () => {
  for (const body of [
    health(null),
    { status: "ok" },
    null,
    health("yesterday-ish"),
    health("2026-09-09T12:00:00Z"),
  ]) {
    const r = checkBackupFreshness(body, { assert: true, now: NOW });
    assert.equal(r.passed, false, JSON.stringify(body));
    if (body) assert.equal(r.outcome, "unknown", JSON.stringify(body));
  }
  assert.match(
    checkBackupFreshness(health(null), { assert: true, now: NOW }).detail,
    /no clean backup has completed/,
  );
  // A negative age would pass a plain "under 26h" test; inside the one hour clock skew it still passes.
  assert.match(
    checkBackupFreshness(health("2026-09-09T12:00:00Z"), { assert: true, now: NOW }).detail,
    /24h in the future/,
  );
  assert.equal(
    checkBackupFreshness(health("2026-09-08T12:30:00Z"), { assert: true, now: NOW }).passed,
    true,
  );
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
