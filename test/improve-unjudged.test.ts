import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CONSECUTIVE_REVERTS, MAX_CONSECUTIVE_UNJUDGED, SCORE_TIMEOUT_MS } from "../src/improve-schema.ts";
import { ingestScore, tickRuns } from "../src/improve-run.ts";
import type { ScoreReport } from "../src/improve-scorer.ts";
import { withFetch } from "./fakes.ts";
import { ARCHIVE_DOC, ATTEMPT, AWAITING, BASELINE, harness, MODEL_ROUTE, NOW, report as baseReport } from "./improve-harness.ts";

// A broken machine is not a bad change.
//
// A revert moves the revert counters and marks the proposing skill bad, and lineage
// selection and the skill records later read that verdict as a measurement. So the
// verdict for an environment failure is UNJUDGED: the attempt is not kept, not
// reverted, and not counted. It has its own ceiling, so an attempt that produced no
// measurement is not retried forever.
//
// Unjudged costs the attempt nothing, so anything the attempt itself can provoke
// must stay a revert; that side is pinned in the holdout and late-report sections.

const LATE = new Date(Date.parse("2026-09-04T08:04:00Z") + SCORE_TIMEOUT_MS + 60_000);

// The unjudged tests send an environment verdict on every report. The shared fixture
// leaves it out, so improve-run.test.ts keeps covering a report without one.
const report = (over: Partial<ScoreReport> = {}): ScoreReport =>
  baseReport({ environment: { ok: true, reason: null }, ...over });

// the timeout path: a score that never arrives

test("A SCORE THAT NEVER ARRIVES LEAVES THE ATTEMPT UNJUDGED, and moves no revert counter", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({ improveRuns: [AWAITING], improveAttempts: [ATTEMPT] });
    await tickRuns(env, LATE);
    const run = d1.rows.improve_runs[0];
    assert.equal(d1.rows.improve_attempts[0].kept, 0, "an unjudged attempt is never kept");
    assert.equal(run.reverts, 0, "a machine that never reported was counted as a revert");
    assert.equal(run.consecutive_reverts, 0, "a machine that never reported moved the restore-to-best counter");
    assert.equal(run.consecutive_unjudged, 1, "the unjudged counter did not move");
    assert.equal(run.status, "attempting", "the run wedged instead of continuing");
  });
});

test("FIVE BROKEN MACHINES IN A ROW DO NOT RESTORE THE NAMESPACE TO BEST", async () => {
  // With consecutive_reverts one short of the ceiling, a timeout must not tip the run
  // into restoring the namespace to best, blaming code that was never measured.
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      improveRuns: [{ ...AWAITING, consecutive_reverts: MAX_CONSECUTIVE_REVERTS - 1, reverts: 4, attempts: 5 }],
      improveAttempts: [ATTEMPT],
    });
    await tickRuns(env, LATE);
    const run = d1.rows.improve_runs[0];
    assert.equal(run.consecutive_reverts, MAX_CONSECUTIVE_REVERTS - 1, "a broken machine advanced the revert counter");
    assert.doesNotMatch(
      String(run.note ?? ""),
      /restored to the best known commit/,
      "a broken machine restored the namespace to best and stopped the run"
    );
  });
});

test("THE UNJUDGED CEILING STOPS THE RUN, and the note names the machine rather than the code", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      improveRuns: [{ ...AWAITING, consecutive_unjudged: MAX_CONSECUTIVE_UNJUDGED - 1, attempts: 3 }],
      improveAttempts: [ATTEMPT],
    });
    await tickRuns(env, LATE);
    const run = d1.rows.improve_runs[0];
    assert.equal(run.consecutive_unjudged, MAX_CONSECUTIVE_UNJUDGED);
    assert.equal(run.status, "finalizing", "the run kept dispatching attempts into a broken machine");
    assert.match(
      String(run.note ?? ""),
      /scoring environment/i,
      "the note must name the machine: nothing was measured, so nothing about the code is known"
    );
    assert.doesNotMatch(
      String(run.note ?? ""),
      /consecutive reverts|restored to the best/i,
      "the note reports a machine failure in the words of a code failure"
    );
  });
});

test("a broken machine does NOT mark the proposing skill bad", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      improveRuns: [AWAITING],
      improveAttempts: [{ ...ATTEMPT, skill_id: "sk-1" }],
      improveSkills: [{ id: "sk-1", source_namespace: "foxing", wins: 0, losses: 0 }],
    });
    await tickRuns(env, LATE);
    assert.equal(d1.rows.improve_skills[0].losses, 0, "a skill was recorded as losing on a run that never scored it");
    assert.equal(d1.rows.improve_skills[0].wins, 0);
  });
});

// the container that never finished

test("A REPORT WHOSE CONTAINER NEVER FINISHED IS UNJUDGED, not a clean 0 of N", async () => {
  // A container that fails to start yields an empty stream and a count of 0, which
  // would otherwise look like an attempt that broke every hidden test.
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const result = await ingestScore(
      env,
      report({
        holdout: { total: 11, passed: 0 },
        environment: { ok: false, reason: "the holdout container did not finish: the stream carries no end marker" },
      }),
      NOW
    );
    assert.equal(result.kept, false);
    assert.equal(d1.rows.improve_attempts[0].status, "unjudged");
    assert.equal(d1.rows.improve_runs[0].reverts, 0, "a container that never ran was recorded as a bad change");
    assert.equal(d1.rows.improve_runs[0].consecutive_reverts, 0);
    assert.equal(d1.rows.improve_runs[0].consecutive_unjudged, 1);
  });
});

test("a finished container reporting 0 of N IS a revert, because that is a real measurement", async () => {
  // Unjudged is for a measurement that did not happen, never for one that came out badly.
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    await ingestScore(env, report({ holdout: { total: 11, passed: 0 } }), NOW);
    assert.equal(d1.rows.improve_attempts[0].status, "reverted");
    assert.equal(d1.rows.improve_runs[0].reverts, 1);
    assert.equal(d1.rows.improve_runs[0].consecutive_reverts, 1);
  });
});

// the holdout refusals

test("A MISSING HOLDOUT MANIFEST LEAVES THE ATTEMPT UNJUDGED", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
      holdoutTotal: null,
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.kept, false);
    assert.equal(d1.rows.improve_attempts[0].status, "unjudged", "a suite that never arrived was scored as a failure");
    assert.equal(d1.rows.improve_runs[0].reverts, 0);
    assert.equal(d1.rows.improve_runs[0].consecutive_unjudged, 1);
  });
});

test("A PARTIAL SYNC (a holdout count below the manifest) LEAVES THE ATTEMPT UNJUDGED", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
      holdoutTotal: 11,
    });
    await ingestScore(env, report({ holdout: { total: 7, passed: 7 } }), NOW);
    assert.equal(d1.rows.improve_attempts[0].status, "unjudged", "a partial sync was scored as a failed hidden suite");
    assert.equal(d1.rows.improve_runs[0].reverts, 0);
  });
});

test("a ZERO-TEST manifest leaves the attempt unjudged", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
      holdoutTotal: 0,
    });
    await ingestScore(env, report({ holdout: { total: 0, passed: 0 } }), NOW);
    assert.equal(d1.rows.improve_attempts[0].status, "unjudged");
    assert.equal(d1.rows.improve_runs[0].reverts, 0);
  });
});

test("AN IMPOSSIBLE HOLDOUT COUNT IS STILL A REVERT, never an environment failure", async () => {
  // A report claiming more passes than the manifest declares is a broken or forged
  // report, not a machine that failed to run. Routing it to unjudged would let an
  // attempt escape being judged.
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
      holdoutTotal: 11,
    });
    await ingestScore(env, report({ holdout: { total: 11, passed: 99 } }), NOW);
    assert.equal(d1.rows.improve_attempts[0].status, "reverted");
    assert.equal(d1.rows.improve_runs[0].reverts, 1);
  });
});

// the late report

test("AN UNJUDGED ATTEMPT ACCEPTS A LATE REAL SCORE onto its own row", async () => {
  // The run has moved on and holds no current_attempt, so the late report cannot
  // drive the state machine. It is still the attempt's only real measurement, and
  // lineage selection and the skill records read the attempt row.
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [{ ...AWAITING, status: "attempting", current_attempt: null, attempts: 2, consecutive_unjudged: 1 }],
      improveAttempts: [{ ...ATTEMPT, status: "unjudged", reason: "no score report after 51 minutes" }],
      improveScores: BASELINE,
      improveSkills: [{ id: "sk-1", source_namespace: "foxing", wins: 0, losses: 0 }],
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.ok, true);
    const attempt = d1.rows.improve_attempts[0];
    assert.equal(attempt.status, "kept", "the late report was discarded and the row still says the machine broke");
    assert.match(String(attempt.reason ?? ""), /late/i, "the row does not say the verdict arrived late");
  });
});

test("a late score does NOT rewind the run's counters or its state", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [{ ...AWAITING, status: "attempting", current_attempt: null, attempts: 2, kept: 0, consecutive_unjudged: 1 }],
      improveAttempts: [{ ...ATTEMPT, status: "unjudged" }],
      improveScores: BASELINE,
    });
    await ingestScore(env, report(), NOW);
    const run = d1.rows.improve_runs[0];
    assert.equal(run.status, "attempting", "a late report drove the state machine backwards");
    assert.equal(run.attempts, 2, "a late report moved the attempt counter");
    assert.equal(run.kept, 0, "a late report counted a keep the run had already moved past");
    assert.equal(run.consecutive_unjudged, 1, "a late report edited the unjudged counter");
  });
});

test("a late score for an attempt ALREADY JUDGED is still ignored", async () => {
  // A report for an attempt already kept or reverted changes nothing, whenever it arrives.
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [{ ...AWAITING, status: "attempting", current_attempt: null, reverts: 1 }],
      improveAttempts: [{ ...ATTEMPT, status: "reverted", reason: "reverted: no improvement", kept: 0 }],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.ok, true);
    assert.match(String(result.message), /duplicate|stale|already/i);
    assert.equal(d1.rows.improve_attempts[0].status, "reverted", "a late report flipped an attempt that was already judged");
    assert.equal(d1.rows.improve_runs[0].reverts, 1);
  });
});
