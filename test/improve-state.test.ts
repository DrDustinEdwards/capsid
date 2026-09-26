import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODE, IMPROVE_MODES } from "../src/improve-schema.ts";
import {
  activeRun,
  advanceRun,
  advanceableRuns,
  attemptsForRun,
  pauseNamespace,
  pausedReason,
  readBest,
  readMode,
  runById,
  writeBest,
} from "../src/improve-state.ts";
import { fakeD1, fakeKv } from "./fakes.ts";

// The mode switch, the pause key, and the idempotent transition. The improve document
// write is driven against a real D1 in test-integration/improve-doc-snapshot.test.ts.

// the mode switch

test("every declared mode reads back as itself", async () => {
  assert.ok(IMPROVE_MODES.length > 0, "IMPROVE_MODES is empty, so this checks nothing");
  for (const mode of IMPROVE_MODES) {
    const { kv } = fakeKv({ seed: { improve_mode: mode } });
    const read = await readMode(kv);
    assert.equal(read.mode, mode);
    assert.equal(read.reason, null, `${mode} was accepted with a complaint`);
  }
});

test("AN UNSET KEY IS off, and says so", async () => {
  const { kv } = fakeKv();
  const read = await readMode(kv);
  assert.equal(read.mode, "off");
  assert.equal(read.mode, DEFAULT_MODE);
  assert.match(read.reason ?? "", /improve_mode is unset/);
});

test("AN UNRECOGNISED VALUE IS off, not a guess", async () => {
  // An unexpected KV string must never start the loop writing to repos.
  for (const value of ["on", "yes", "true", "1", "sub", "subscribe", "", "apix"]) {
    const { kv } = fakeKv({ seed: { improve_mode: value } });
    const read = await readMode(kv);
    assert.equal(read.mode, "off", `'${value}' was not treated as off`);
    assert.match(read.reason ?? "", /unrecognised value/);
  }
});

test("whitespace and case are normalised, because those are typos rather than intentions", async () => {
  for (const [value, expected] of [
    ["  Subscription \n", "subscription"],
    ["API", "api"],
    ["OFF", "off"],
  ] as const) {
    const { kv } = fakeKv({ seed: { improve_mode: value } });
    const read = await readMode(kv);
    assert.equal(read.mode, expected);
    assert.equal(read.reason, null);
  }
});

test("AN UNREADABLE KV IS off", async () => {
  const { kv } = fakeKv({ failGet: true });
  const read = await readMode(kv);
  assert.equal(read.mode, "off");
  assert.match(read.reason ?? "", /could not read improve_mode/);
});

// the pause key

test("a pause key is a reason, and an unreadable KV reads as paused", async () => {
  const set = fakeKv({ seed: { "improve:paused:foxing": "anchors dropped" } });
  assert.equal(await pausedReason(set.kv, "foxing"), "anchors dropped");
  assert.equal(await pausedReason(set.kv, "capsid"), null);

  const broken = fakeKv({ failGet: true });
  assert.match((await pausedReason(broken.kv, "capsid")) ?? "", /could not read the pause key/);
});

test("A PAUSE CARRIES NO TTL, so it cannot expire itself back into service", async () => {
  const { kv, puts } = fakeKv();
  await pauseNamespace(kv, "foxing", "because");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, "improve:paused:foxing");
  assert.equal(puts[0].ttl, undefined, "the pause key carries an expiry; a pause must be cleared by a human");
});

// the best record

test("a best record round-trips", async () => {
  const { kv } = fakeKv();
  const record = {
    sha: "abc",
    run_id: "r",
    attempt_id: "a",
    recorded_at: "2026-09-04T00:00:00Z",
    anchors: { build_passes: 1 },
    secondary: { lint_count: 2 },
    score: 4,
  };
  await writeBest(kv, "capsid", record);
  assert.deepEqual(await readBest(kv, "capsid"), record);
});

test("a CORRUPT best record reads as absent, not as a throw", async () => {
  // Throwing would wedge every future run on one bad JSON value. Absent means the
  // run branches from the default branch, which is a worse base but a safe one.
  for (const value of ["{not json", "null", "{}", '{"sha":""}', "[]"]) {
    const { kv } = fakeKv({ seed: { "improve:best:capsid": value } });
    assert.equal(await readBest(kv, "capsid"), null, `'${value}' did not read as absent`);
  }
});

// transitions

const RUN = { id: "capsid-r1", namespace: "capsid", status: "attempting", attempts: 2 };

test("a transition from the EXPECTED status lands, and reports that it did", async () => {
  const { db, rows } = fakeD1({ improveRuns: [RUN] });
  const moved = await advanceRun(db, { runId: "capsid-r1", expected: "attempting", next: "awaiting-score" });
  assert.equal(moved, true);
  assert.equal(rows.improve_runs[0].status, "awaiting-score");
});

test("A REPLAYED TRANSITION IS A NO-OP, not an error and not a double count", async () => {
  // Ticks overlap, an isolate can die between a GitHub call and the row update,
  // and a hand-run improve_run can land in the middle of both. Any of those
  // replays a transition.
  const { db, rows } = fakeD1({ improveRuns: [RUN] });
  const first = await advanceRun(db, {
    runId: "capsid-r1",
    expected: "attempting",
    next: "awaiting-score",
    patch: { attempts: 3 },
  });
  const second = await advanceRun(db, {
    runId: "capsid-r1",
    expected: "attempting",
    next: "awaiting-score",
    patch: { attempts: 4 },
  });
  assert.equal(first, true);
  assert.equal(second, false, "the replay was applied");
  assert.equal(rows.improve_runs[0].attempts, 3, "the replay's patch landed, double-counting the attempt");
});

test("a transition from the WRONG status changes nothing", async () => {
  const { db, rows } = fakeD1({ improveRuns: [RUN] });
  const moved = await advanceRun(db, { runId: "capsid-r1", expected: "opening", next: "done" });
  assert.equal(moved, false);
  assert.equal(rows.improve_runs[0].status, "attempting");
});

test("a transition for a run that does not exist changes nothing", async () => {
  const { db, rows } = fakeD1({ improveRuns: [RUN] });
  assert.equal(await advanceRun(db, { runId: "no-such-run", expected: "attempting", next: "done" }), false);
  assert.equal(rows.improve_runs[0].status, "attempting");
});

test("a patch writes every field it names, and nothing it does not", async () => {
  const { db, rows } = fakeD1({ improveRuns: [{ ...RUN, kept: 1, reverts: 1, note: "keep me" }] });
  await advanceRun(db, {
    runId: "capsid-r1",
    expected: "attempting",
    next: "finalizing",
    patch: { kept: 5, consecutive_reverts: 3, pr_url: "https://example.com/pr/1" },
  });
  const row = rows.improve_runs[0];
  assert.equal(row.kept, 5);
  assert.equal(row.consecutive_reverts, 3);
  assert.equal(row.pr_url, "https://example.com/pr/1");
  assert.equal(row.reverts, 1, "an unnamed field was overwritten");
  assert.equal(row.note, "keep me", "an unnamed field was overwritten");
});

test("every transition stamps advanced_at, which the age guard reads", async () => {
  const { db, rows } = fakeD1({ improveRuns: [{ ...RUN, advanced_at: "2020-01-01 00:00:00" }] });
  await advanceRun(db, { runId: "capsid-r1", expected: "attempting", next: "awaiting-score" });
  assert.notEqual(rows.improve_runs[0].advanced_at, "2020-01-01 00:00:00");
});

// reads

test("activeRun ignores finished runs", async () => {
  const { db } = fakeD1({
    improveRuns: [
      { id: "old", namespace: "capsid", status: "done", started: "2026-09-01 08:00:00" },
      { id: "paused", namespace: "capsid", status: "paused", started: "2026-09-02 08:00:00" },
    ],
  });
  assert.equal(await activeRun(db, "capsid"), null);
});

test("activeRun is scoped to its namespace", async () => {
  const { db } = fakeD1({
    improveRuns: [{ id: "foxing-r1", namespace: "foxing", status: "attempting", started: "2026-09-03 08:00:00" }],
  });
  assert.equal(await activeRun(db, "capsid"), null);
  assert.equal((await activeRun(db, "foxing"))?.id, "foxing-r1");
});

test("advanceableRuns returns the oldest-advanced first, and only unfinished ones", async () => {
  const { db } = fakeD1({
    improveRuns: [
      { id: "newer", namespace: "a", status: "attempting", advanced_at: "2026-09-04 08:10:00" },
      { id: "older", namespace: "b", status: "awaiting-score", advanced_at: "2026-09-04 08:00:00" },
      { id: "finished", namespace: "c", status: "done", advanced_at: "2026-09-04 07:00:00" },
    ],
  });
  const runs = await advanceableRuns(db, 10);
  assert.deepEqual(runs.map((r) => r.id), ["older", "newer"]);
});

test("advanceableRuns honours its limit, so a tick cannot run unbounded", async () => {
  const { db } = fakeD1({
    improveRuns: Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      namespace: `ns${i}`,
      status: "attempting",
      advanced_at: `2026-09-04 08:0${i}:00`,
    })),
  });
  assert.equal((await advanceableRuns(db, 3)).length, 3);
});

test("runById and attemptsForRun resolve their binds, so a wrong id gets nothing", async () => {
  const { db } = fakeD1({
    improveRuns: [{ id: "capsid-r1", namespace: "capsid" }],
    improveAttempts: [
      { id: "a1", run_id: "capsid-r1", ts: "2026-09-04 08:01:00" },
      { id: "a2", run_id: "capsid-r1", ts: "2026-09-04 08:02:00" },
      { id: "b1", run_id: "other-run", ts: "2026-09-04 08:03:00" },
    ],
  });
  assert.equal((await runById(db, "capsid-r1"))?.id, "capsid-r1");
  assert.equal(await runById(db, "nope"), null);
  assert.deepEqual((await attemptsForRun(db, "capsid-r1")).map((a) => a.id), ["a1", "a2"]);
  assert.deepEqual(await attemptsForRun(db, "nope"), []);
});
