import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY_CAP_REASON, atCorrectionCap, cappedSummary } from "../src/jobs-schema.ts";

// GROUP 2: TWO CORRECTIONS, THEN A HUMAN.
//
// `resume` made a gate a pause rather than an ending, which is right. What it left
// unbounded is the LOOP: block, sent back, block again, sent back again, block
// again. Every step is defensible on its own and the composition is not, so the
// ceiling is counted rather than judged.
//
// The rules live as pure functions here for the same reason the skill lifecycle
// does: they can be driven to their refusals without a database.
//
// The branch that consults them, resumeJob, is driven against a real D1 in
// test-integration/jobs.test.ts ("the retry cap, where resume reads it").

test("a job under the cap is not capped, and a job at it is", () => {
  assert.equal(atCorrectionCap(0), false);
  assert.equal(atCorrectionCap(1), false, "one correction is a driver fixing something, not a loop");
  assert.equal(atCorrectionCap(2), true, "the third block is the one a human decides");
  assert.equal(atCorrectionCap(9), true);
});

test("a corrupt or negative count is treated as at the cap, not under it", () => {
  // Fail closed. A count this function cannot read is a count it cannot bound, and
  // waving that through would hand the loop exactly the case nobody tested.
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
