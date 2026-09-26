import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { holdoutPassCount, markers, parseHoldoutStream } from "../scripts/improve-report.mjs";

// The scorer's half of "an empty stream is not a result". test/improve-unjudged.test.ts
// pins what the Worker does with an environment failure; this file proves the scorer
// reports one, so a container that fails to start says "nothing was measured" rather
// than "0 of 11 hidden tests passed".
//
// holdoutPassCount returns 0 for an unterminated stream, which is the correct score
// and a useless diagnosis. The terminated flag separates the two.

const SCORER = join(import.meta.dirname, "..", "scripts", "improve-report.mjs");
const NONCE = "test-nonce";
const M = markers(NONCE);

// A stream from a container that ran one holdout case and finished.
const FINISHED_ALL_FAILED = [
  `${M.case}one.test.ts`,
  "TAP version 13",
  "1..1",
  "not ok 1 - a hidden case",
  M.end,
  "",
].join("\n");

// The same container, killed before it printed its end marker.
const KILLED = [`${M.case}one.test.ts`, "TAP version 13", "1..1", "not ok 1 - a hidden case", ""].join("\n");

// The container that never started at all: nothing on stdout.
const NEVER_STARTED = "";

function write(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "capsid-env-signal-"));
  const path = join(dir, "holdout.tap");
  writeFileSync(path, text);
  return path;
}

function terminatedExit(text: string): number {
  const result = spawnSync(process.execPath, [SCORER, "--holdout-terminated", write(text), NONCE], { encoding: "utf8" });
  return result.status ?? -1;
}

test("A CONTAINER THAT NEVER STARTED SCORES THE SAME AS ONE THAT FAILED EVERY CASE", () => {
  // Why the count alone cannot be the signal. The terminated flag is a second fact;
  // it does not change the score.
  assert.equal(holdoutPassCount(NEVER_STARTED, NONCE), 0);
  assert.equal(holdoutPassCount(FINISHED_ALL_FAILED, NONCE), 0);
});

test("THE TERMINATED FLAG SEPARATES THEM, and the CLI reports it by exit code", () => {
  assert.equal(parseHoldoutStream(FINISHED_ALL_FAILED, NONCE).terminated, true);
  assert.equal(parseHoldoutStream(KILLED, NONCE).terminated, false);
  assert.equal(parseHoldoutStream(NEVER_STARTED, NONCE).terminated, false);

  assert.equal(terminatedExit(FINISHED_ALL_FAILED), 0, "a finished container must not be reported as an environment failure");
  assert.equal(terminatedExit(KILLED), 1, "a killed container was reported as a finished one");
  assert.equal(terminatedExit(NEVER_STARTED), 1, "a container that never started was reported as a finished one");
});

test("an unreadable stream is an environment failure, never a pass", () => {
  const result = spawnSync(process.execPath, [SCORER, "--holdout-terminated", join(tmpdir(), "capsid-no-such-file.tap"), NONCE], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, "a missing stream file must fail closed");
});

// The signed body carries it.

function signedBody(env: Record<string, string>): {
  environment: { ok: boolean; reason: string | null };
  holdout: { total: number; passed: number };
} {
  const dir = mkdtempSync(join(tmpdir(), "capsid-env-body-"));
  const metricsPath = join(dir, "metrics.json");
  writeFileSync(metricsPath, JSON.stringify({ bundle_size_bytes: 4242 }));
  return JSON.parse(
    execFileSync(process.execPath, [SCORER, metricsPath, "11", "0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        IMPROVE_NAMESPACE: "capsid",
        RUN_ID: "r1",
        ATTEMPT_ID: "a1",
        ATTEMPT_HEAD_SHA: "deadbeef",
        BUILD_PASSES: "1",
        SECONDARY_TEST_PASS_RATE: "0.9",
        SECONDARY_LINT_COUNT: "3",
        ...env,
      },
    })
  );
}

test("THE SIGNED BODY REPORTS THE ENVIRONMENT FAILURE, so the Worker can see it at all", () => {
  const body = signedBody({ ENV_FAILURE: "1", ENV_FAILURE_REASON: "the holdout container did not finish" });
  assert.equal(body.environment.ok, false);
  assert.match(String(body.environment.reason), /did not finish/);
  // The score is still reported; unjudged is a verdict about the measurement.
  assert.deepEqual(body.holdout, { total: 11, passed: 0 });
});

test("a healthy run reports environment ok, so nothing is spared judgement by default", () => {
  const body = signedBody({});
  assert.deepEqual(body.environment, { ok: true, reason: null });
});

test("only an explicit ENV_FAILURE=1 sets it: a stray value does not spare an attempt", () => {
  assert.equal(signedBody({ ENV_FAILURE: "0" }).environment.ok, true);
  assert.equal(signedBody({ ENV_FAILURE: "true" }).environment.ok, true);
  assert.equal(signedBody({ ENV_FAILURE: "" }).environment.ok, true);
});

// The workflow wires it through.

test("THE WORKFLOW COMPUTES THE FLAG AND PASSES IT TO THE POST STEP", () => {
  // A break anywhere in the chain leaves the Worker scoring every broken machine as a
  // bad change. Read from the file because none of it can be exercised offline.
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml"), "utf8");
  assert.match(workflow, /--holdout-terminated/, "the count step never checks whether the container finished");
  assert.match(workflow, /env_failure=1/, "the count step never sets the flag");
  assert.match(workflow, /ENV_FAILURE:\s*\$\{\{\s*steps\.holdout_count\.outputs\.env_failure\s*\}\}/, "the post step does not receive the flag");
  assert.match(
    workflow,
    /ENV_FAILURE_REASON:\s*\$\{\{\s*steps\.holdout_count\.outputs\.env_reason\s*\}\}/,
    "the post step does not receive the reason"
  );
  // A failed sync is checked from the step's own outcome, not from container output.
  assert.match(workflow, /HOLDOUT_SYNC:\s*\$\{\{\s*steps\.holdout\.outcome\s*\}\}/, "a failed holdout sync is not detected");
});
