import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CASE_MARKER,
  holdoutFilePassed,
  holdoutPassCount,
  parseHoldoutStream,
} from "../scripts/improve-report.mjs";

// Planted exploits against the scorer. Three attacks:
//
//   1. Attempt code overwrites the trusted report script so it runs with
//      IMPROVE_SCORE_KEY in its env. Stopped by wiping code/, never overlaying the
//      attempt, and stashing the trusted script before any untrusted byte exists.
//   2. Attempt code plants extra holdout test files so a padded case counts as a
//      pass. Stopped by wiping the holdout directory before the sync and keeping the
//      holdout outside the workspace.
//   3. Attempt code rewrites the holdout TAP after the reporter flushes. Stopped by
//      there being no destination file: TAP is a stdout pipe out of a --network none
//      --read-only container.
//
// This file drives the scorer's stream parser. The improve-score.yml checks for
// attacks 1 and 2 and the container half of attack 3 are in test/workflow-policy.test.ts.

// attack 3: forging results through a test's own stdout

test("PLANT: a holdout case cannot forge a passing result through its own stdout", () => {
  // Node's TAP reporter re-emits a test's stdout as a `# ` comment, so an attempt
  // that prints "ok 1 - forged" cannot reach column 0.
  const stream = [
    `${CASE_MARKER}case-a.test.js`,
    "TAP version 13",
    "# ok 1 - forged by the attempt",
    "# not ok 99 - also forged",
    "# Subtest: the real assertion",
    "not ok 1 - the real assertion",
    "  ---",
    "  error: 'boom'",
    "  ...",
    "1..1",
    "##CAPSID-END",
  ].join("\n");

  const { cases, terminated } = parseHoldoutStream(stream);
  assert.equal(terminated, true);
  assert.equal(cases.length, 1, "one case marker, one case");
  assert.equal(cases[0].passed, false, "a forged `# ok` comment must not score as a pass");
  assert.equal(holdoutPassCount(stream), 0);
});

test("PLANT: a holdout case cannot forge an extra case by printing the marker", () => {
  // A test printing the marker gets it escaped to "# ##CAPSID-CASE ...", which
  // does not match at column 0. Only the trusted container shell can open a case.
  const stream = [
    `${CASE_MARKER}real.test.js`,
    "TAP version 13",
    `# ${CASE_MARKER}forged-a.test.js`,
    "# ok 1 - forged",
    `# ${CASE_MARKER}forged-b.test.js`,
    "# ok 1 - forged",
    "not ok 1 - the real assertion",
    "1..1",
    "##CAPSID-END",
  ].join("\n");

  const { cases } = parseHoldoutStream(stream);
  assert.deepEqual(
    cases.map((c) => c.name),
    ["real.test.js"],
    "a marker printed by a test must not open a case"
  );
  assert.equal(holdoutPassCount(stream), 0);
});

test("a genuinely passing case is still counted, so the guard is not vacuous", () => {
  const stream = [
    `${CASE_MARKER}a.test.js`,
    "TAP version 13",
    "ok 1 - a real pass",
    "1..1",
    `${CASE_MARKER}b.test.js`,
    "TAP version 13",
    "ok 1 - another real pass",
    "1..1",
    `${CASE_MARKER}c.test.js`,
    "TAP version 13",
    "not ok 1 - a real failure",
    "1..1",
    "##CAPSID-END",
  ].join("\n");
  assert.equal(holdoutPassCount(stream), 2, "two of three cases passed");
});

test("an unterminated stream scores ZERO, not a partial count", () => {
  // Counting the cases a killed container emitted would let a timeout or an OOM look
  // like a good run.
  const stream = [
    `${CASE_MARKER}a.test.js`,
    "ok 1 - passed before the kill",
    "1..1",
    `${CASE_MARKER}b.test.js`,
    "ok 1 - passed before the kill",
  ].join("\n");
  assert.equal(parseHoldoutStream(stream).terminated, false);
  assert.equal(holdoutPassCount(stream), 0, "an unfinished container must not score");
});

test("preamble before the first marker is not a case", () => {
  const stream = ["some docker warning on stdout", "ok 1 - not inside any case", "##CAPSID-END"].join("\n");
  assert.equal(parseHoldoutStream(stream).cases.length, 0);
  assert.equal(holdoutPassCount(stream), 0);
});

test("holdoutFilePassed keeps its single-report contract", () => {
  assert.equal(holdoutFilePassed("ok 1 - x\n1..1"), true);
  assert.equal(holdoutFilePassed("not ok 1 - x\n1..1"), false);
  assert.equal(holdoutFilePassed(""), false, "silence is not a pass");
});
