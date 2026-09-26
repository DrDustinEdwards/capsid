import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - a .mjs script with no type declarations, driven here for real.
import { rollbackTookEffect, shouldRollBack } from "../scripts/rollback-guard.mjs";

// The rollback guard: roll back only when the deploy this run shipped is what is live.
//
// Rerunning only the failed live job preserves `needs.deploy.result`, so the rollback
// step's `if:` still holds, and `wrangler rollback` with no version id means "the
// previous version". A second rollback therefore puts back the very commit the first
// one removed.

const LIVE_SHA = "4df127439ed3aa19aef8e350ab6311957b8f8611";
const PREVIOUS_SHA = "376eecb3bc27c6d744de35453cfad7a08bdc1d5f";

test("the deploy this run shipped IS live: roll it back", () => {
  const verdict = shouldRollBack(LIVE_SHA, LIVE_SHA);
  assert.equal(verdict.roll, true, verdict.reason);
  assert.match(verdict.reason, /this run's own commit/);
});

test("THE RERUN CASE: what is live is not this run's deploy, so nothing is rolled back", () => {
  // Attempt 2: this run's commit is LIVE_SHA, but attempt 1's rollback already put
  // PREVIOUS_SHA live. Rolling back here would put the refused commit back.
  const verdict = shouldRollBack(PREVIOUS_SHA, LIVE_SHA);
  assert.equal(verdict.roll, false, "the second rollback would run again");
  assert.match(verdict.reason, /already gone/);
});

test("an abbreviated sha on either side still compares equal", () => {
  // The comparison must not depend on /health serving the full sha.
  assert.equal(shouldRollBack(LIVE_SHA.slice(0, 8), LIVE_SHA).roll, true);
  assert.equal(shouldRollBack(LIVE_SHA, LIVE_SHA.slice(0, 8)).roll, true);
  assert.equal(shouldRollBack(PREVIOUS_SHA.slice(0, 8), LIVE_SHA).roll, false);
});

test("an unreadable /health REFUSES rather than rolling back blind", () => {
  // The step's reader writes these words when /health does not answer or does not
  // parse. A rollback is a production change and must not be made without knowing
  // what is live.
  for (const value of ["unknown", "unreadable", "", "   "]) {
    const verdict = shouldRollBack(value, LIVE_SHA);
    assert.equal(verdict.roll, false, `'${value}' was treated as permission to roll back`);
  }
  assert.match(shouldRollBack("unreadable", LIVE_SHA).reason, /cannot be established/);
});

test("a missing run sha refuses, rather than comparing against nothing", () => {
  assert.equal(shouldRollBack(LIVE_SHA, "").roll, false);
});

// The guard only matters if the workflow consults it.
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

// When /health is down. A deploy that breaks /health reads as "unreadable", and
// refusing then would leave the most broken deploys live. The rerun case is told apart
// by run_attempt: the deploy job's outputs survive a rerun of the live job alone, so
// its attempt number is the earlier one.
test("unreadable /health rolls back when the deploy ran in this same attempt", () => {
  const verdict = shouldRollBack("unreadable", LIVE_SHA, { deployAttempt: "1", runAttempt: "1" });
  assert.equal(verdict.roll, true, verdict.reason);
});

test("unreadable /health in a RERUN still refuses", () => {
  const verdict = shouldRollBack("unreadable", LIVE_SHA, { deployAttempt: "1", runAttempt: "2" });
  assert.equal(verdict.roll, false, verdict.reason);
  assert.match(verdict.reason, /cannot be established/);
});

test("a sha shorter than 7 hex characters is not a sha", () => {
  // "4d" prefixes this run's sha and must not approve the rollback.
  assert.equal(shouldRollBack("4d", LIVE_SHA).roll, false);
  assert.equal(shouldRollBack("4df127", LIVE_SHA).roll, false);
  assert.equal(shouldRollBack("4df1274", LIVE_SHA).roll, true);
  assert.equal(shouldRollBack("not-a-sha", LIVE_SHA).roll, false);
});

test("the rollback took effect only when a readable, different sha is live", () => {
  assert.equal(rollbackTookEffect(PREVIOUS_SHA, LIVE_SHA).moved, true);
  // The sha never moved, so the rollback did not take effect.
  const same = rollbackTookEffect(LIVE_SHA, LIVE_SHA);
  assert.equal(same.moved, false);
  assert.match(same.reason, /did not take effect/);
  assert.equal(rollbackTookEffect("unreadable", LIVE_SHA).moved, false);
  assert.equal(rollbackTookEffect("", LIVE_SHA).moved, false);
});

test("the rollback step runs on a refusal only, reads /health without -f, and checks the sha moved", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const step = /- name: Roll back the deploy this run shipped\n([\s\S]*?)\n      - name: /.exec(workflow);
  assert.ok(step, "the rollback step was not found");
  const body = step[1];
  // Exit 3 from verify:live is "could not run" and must not roll back.
  assert.match(body, /steps\.verify\.outputs\.exit_code == '1'/, "the rollback no longer waits for a refusal");
  assert.match(workflow, /- name: verify:live\n\s+id: verify\n/, "the verify step has no id, so its exit code cannot be read");
  assert.match(workflow, /echo "exit_code=\$\{code\}" >> "\$GITHUB_OUTPUT"/, "the verify step does not record its exit code");
  // curl -f turns a 5xx into a step abort under set -e, before the guard runs.
  assert.doesNotMatch(body, /curl -f/, "the rollback reads /health with -f again");
  assert.match(body, /\$\{DEPLOY_ATTEMPT\}" "\$\{GITHUB_RUN_ATTEMPT\}"/, "the guard is not told which attempt deployed");
  assert.match(workflow, /outputs:\n\s+attempt: \$\{\{ github\.run_attempt \}\}/, "the deploy job does not publish its attempt");
  assert.match(body, /rollback-guard\.mjs --after/, "the step no longer checks that the rollback took effect");
  assert.match(body, /did not take effect[\s\S]*exit 1/, "a rollback that never moved the sha does not fail the step");
});
