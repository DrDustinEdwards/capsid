import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - a .mjs script with no type declarations, driven here for real.
import { shouldRollBack } from "../scripts/rollback-guard.mjs";

// THE ROLLBACK THAT RAN TWICE AND MOVED PRODUCTION FORWARD.
//
// On 2026-09-18 the live gate on run 35300342260 crashed on a transient ECONNRESET
// after passing its first gates. The rollback step did what it was meant to and put
// the previous version back. The seat then reran ONLY the failed live job, and:
//
//   - `needs.deploy.result` is preserved across a rerun of one job, so it was still
//     'success' from attempt 1 and the step's `if:` condition held.
//   - The rollback ran a SECOND time. `wrangler rollback` with no version id means
//     "the previous version", which after the first rollback was the 4df1274 build
//     the first rollback had just backed out.
//
// Production ended up running the exact commit the gate had refused. Nothing was
// wrong with that commit, as it turned out, but nothing in the system knew that.
//
// These drive the real script with the real shas from that incident.

const LIVE_SHA = "4df127439ed3aa19aef8e350ab6311957b8f8611";
const PREVIOUS_SHA = "376eecb3bc27c6d744de35453cfad7a08bdc1d5f";

test("the deploy this run shipped IS live: roll it back", () => {
  const verdict = shouldRollBack(LIVE_SHA, LIVE_SHA);
  assert.equal(verdict.roll, true, verdict.reason);
  assert.match(verdict.reason, /this run's own commit/);
});

test("THE RERUN CASE: what is live is not this run's deploy, so nothing is rolled back", () => {
  // Attempt 2's position exactly: this run's commit is 4df1274, but attempt 1's
  // rollback already put 376eecb3 live. Rolling back here is what moved production
  // onto the refused commit.
  const verdict = shouldRollBack(PREVIOUS_SHA, LIVE_SHA);
  assert.equal(verdict.roll, false, "the second rollback would run again");
  assert.match(verdict.reason, /already gone/);
});

test("an abbreviated sha on either side still compares equal", () => {
  // /health serves the full sha today. The comparison should not depend on that.
  assert.equal(shouldRollBack(LIVE_SHA.slice(0, 8), LIVE_SHA).roll, true);
  assert.equal(shouldRollBack(LIVE_SHA, LIVE_SHA.slice(0, 8)).roll, true);
  assert.equal(shouldRollBack(PREVIOUS_SHA.slice(0, 8), LIVE_SHA).roll, false);
});

test("an unreadable /health REFUSES rather than rolling back blind", () => {
  // The step's reader writes exactly these two words when /health does not answer or
  // does not parse. A rollback is a production change; making one without knowing
  // what is live is the move this guard exists to stop.
  for (const value of ["unknown", "unreadable", "", "   "]) {
    const verdict = shouldRollBack(value, LIVE_SHA);
    assert.equal(verdict.roll, false, `'${value}' was treated as permission to roll back`);
  }
  assert.match(shouldRollBack("unreadable", LIVE_SHA).reason, /cannot be established/);
});

test("a missing run sha refuses, rather than comparing against nothing", () => {
  assert.equal(shouldRollBack(LIVE_SHA, "").roll, false);
});

// The guard is only real if the workflow actually consults it. A script nothing calls
// is a guard nobody has.
test("the rollback step calls the guard BEFORE it calls wrangler rollback", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const step = /- name: Roll back the deploy this run shipped\n([\s\S]*?)\n      - name: /.exec(workflow);
  assert.ok(step, "the rollback step was not found; this test is pinned to its name");
  const body = step[1];
  const guardAt = body.indexOf("scripts/rollback-guard.mjs");
  const rollbackAt = body.indexOf("wrangler@4.107.0 rollback");
  assert.ok(guardAt > -1, "the rollback step does not call the guard at all");
  assert.ok(rollbackAt > -1, "the rollback step no longer calls wrangler rollback; this test is stale");
  assert.ok(guardAt < rollbackAt, "the guard runs AFTER the rollback, which decides nothing");
  // And the refusal must not fail the step: the gate has already failed the run, and
  // a red rollback step on top of it says the rollback broke rather than declined.
  assert.match(body, /exit 0/, "a declined rollback should leave the step green, not add a second failure");
});
