import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET_MS, verdict } from "../scripts/test-budget.mjs";

// THE UNIT SUITE'S TIME BUDGET. `npm test` runs scripts/test-budget.mjs, which times
// the node --test process and fails the run on CI when it is over budget.

test("the budget is 60 seconds", () => {
  assert.equal(BUDGET_MS, 60_000);
});

test("PLANT: over budget on CI fails, and says by how much", () => {
  const result = verdict(BUDGET_MS + 1, "true");
  assert.equal(result.fail, true);
  assert.match(result.message, /60\.0s, over the 60s budget/);
});

test("THE INNOCENT DIRECTION: under budget on CI passes", () => {
  assert.equal(verdict(BUDGET_MS - 1, "true").fail, false);
  assert.equal(verdict(BUDGET_MS, "true").fail, false, "exactly the budget is within it");
});

test("off CI the time is reported and never fails the run", () => {
  for (const ci of [undefined, "", "false", "1"]) {
    const result = verdict(BUDGET_MS * 3, ci);
    assert.equal(result.fail, false, `CI=${String(ci)} failed the run`);
    assert.match(result.message, /enforced only when CI=true/);
  }
});
