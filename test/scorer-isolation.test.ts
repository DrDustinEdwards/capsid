import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CASE_MARKER,
  holdoutFilePassed,
  holdoutPassCount,
  parseHoldoutStream,
} from "../scripts/improve-report.mjs";

// PLANTED EXPLOITS AGAINST THE SCORER, from the 2026-09-07 audits.
//
// Opus CRITICAL 5.1 and Grok CRITICAL 1 and 2 named three live attacks against the
// old two-job scorer. Every assertion in this file is written so that it FAILS on
// the code as it stood at 257e625, which is the standard capsid/conventions.md
// sets: a guard that has never been observed failing has not been verified.
//
// The three attacks, and where each is now stopped:
//
//   1. Attempt code writes code/scripts/improve-report.mjs during Job A's own test
//      step. Job A did not wipe code/ first, so it rode into the artifact; Job B
//      then ran `cp -r attempt/code/. .` over its default-branch checkout, and the
//      Post step executed the attacker's script WITH IMPROVE_SCORE_KEY in its env.
//      Stopped three ways: Job A wipes code/, Job B never overlays anything, and
//      the trusted script is stashed outside the workspace before any untrusted
//      byte exists.
//   2. The same overlay planted extra .improve-holdout/*.test.* files that the
//      credential-scoped `aws s3 sync` did not delete, so a padded case counted as
//      a pass. Stopped by wiping the holdout directory before the sync and by the
//      holdout living outside the workspace entirely.
//   3. Holdout TAP went to a seekable file inside the attempt's own filesystem, so
//      attempt code rewrote it from process.on('exit') after the reporter flushed.
//      Stopped by there being no destination file: TAP is a stdout pipe out of a
//      --network none --read-only container.
//
// This file drives the scorer's stream parser. The checks on improve-score.yml
// that stop attacks 1 and 2 and the container half of attack 3 are in
// test/workflow-policy.test.ts.

// ---- attack 3: forging results through a test's own stdout ------------------

test("PLANT: a holdout case cannot forge a passing result through its own stdout", () => {
  // What node's TAP reporter actually produces when a test writes to stdout: the
  // line is captured and re-emitted as a `# ` comment. Verified by experiment on
  // 2026-09-07 against the exact command the workflow runs. So an attempt that
  // prints "ok 1 - forged" cannot reach column 0.
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
  // A container killed part way through is a failed measurement. Counting the
  // cases it managed to emit would let a timeout or an OOM look like a good run.
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
