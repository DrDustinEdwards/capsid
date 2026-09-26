import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY_CAP_REASON, atCorrectionCap, cappedSummary } from "../src/jobs-schema.ts";

// Two corrections, then a human.
//
// Block, resume, block again can loop without bound, so the ceiling is counted
// rather than judged. The rules are pure functions so they can be driven to their
// refusals without a database; resumeJob, which consults them, is driven against a
// real D1 in test-integration/jobs.test.ts.

test("a job under the cap is not capped, and a job at it is", () => {
  assert.equal(atCorrectionCap(0), false);
  assert.equal(atCorrectionCap(1), false, "one correction is a driver fixing something, not a loop");
  assert.equal(atCorrectionCap(2), true, "the third block is the one a human decides");
  assert.equal(atCorrectionCap(9), true);
});

test("a corrupt or negative count is treated as at the cap, not under it", () => {
  // Fail closed: a count this function cannot read is a count it cannot bound.
  assert.equal(atCorrectionCap(Number.NaN), true);
  assert.equal(atCorrectionCap(-1), true);
});

test("the capped summary names the cap and KEEPS what the driver said", () => {
  const summary = cappedSummary("the push needs a human");
  assert.match(summary, new RegExp(RETRY_CAP_REASON));
  assert.match(summary, /the push needs a human/, "a cap that discards the driver's summary throws away what the human has to decide about");
});

test("capping an empty summary still says why the job stopped", () => {
  assert.match(cappedSummary(null), new RegExp(RETRY_CAP_REASON));
  assert.match(cappedSummary(""), new RegExp(RETRY_CAP_REASON));
});
