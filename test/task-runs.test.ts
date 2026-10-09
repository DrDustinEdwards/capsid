import assert from "node:assert/strict";
import { test } from "node:test";
import { REASON_MAX, runTask, taskStates, TASKS, type TaskId } from "../src/task-runs.ts";
import type { OpsTaskRun } from "../src/ops-types.ts";
import { fakeEnv } from "./fakes.ts";

// The run ledger's recorder and its flags (src/task-runs.ts). The SQL itself, the
// prune and the per-task read run against real D1 in test-integration/task-runs.test.ts,
// and every cron branch writing its row in test-integration/scheduled.test.ts.

interface Bound {
  sql: string;
  args: unknown[];
}

// A D1 that keeps what each batch bound, or refuses every batch.
function ledgerEnv(opts: { refuse?: string } = {}) {
  const batches: Bound[][] = [];
  const DB = {
    prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
    batch: async (statements: Bound[]) => {
      if (opts.refuse) throw new Error(opts.refuse);
      batches.push(statements);
      return [];
    },
  };
  const inserts = () => batches.map((b) => b[0]).map((s) => ({ task: s.args[0], outcome: s.args[3], reason: s.args[4] }));
  return { env: fakeEnv({ DB }), batches, inserts };
}

function capture(stream: "log" | "error") {
  const lines: string[] = [];
  const original = console[stream];
  console[stream] = (...args: unknown[]) => void lines.push(args.join(" "));
  return { lines, restore: () => void (console[stream] = original) };
}

test("a run the judge reports is written once, with an insert and a bounded prune in one batch", async () => {
  const { env, batches, inserts } = ledgerEnv();
  const value = await runTask(env, "backup", async () => 7, (n) => ({ outcome: "ok", reason: `dumped ${n} tables` }), { tag: "T", rethrow: true });
  assert.equal(value, 7);
  assert.deepEqual(inserts(), [{ task: "backup", outcome: "ok", reason: "dumped 7 tables" }]);
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][1].sql, /^DELETE FROM task_runs WHERE id IN \(SELECT id FROM task_runs ORDER BY id LIMIT \?1\) AND finished_at < \?2$/);
});

test("a step that was not due records nothing", async () => {
  const { env, batches } = ledgerEnv();
  assert.equal(await runTask(env, "watcher", async () => "not due", () => null, { tag: "T", rethrow: false }), "not due");
  assert.equal(batches.length, 0);
});

test("PLANT: a throw is recorded as threw with its message and logged with the tag; rethrown for a cron branch", async () => {
  const { env, inserts } = ledgerEnv();
  const errors = capture("error");
  try {
    await assert.rejects(
      runTask(env, "backup", async () => { throw new Error("R2 said no"); }, () => ({ outcome: "ok", reason: "never" }), { tag: "BACKUP_CRON_THREW", rethrow: true }),
      /R2 said no/
    );
  } finally {
    errors.restore();
  }
  assert.deepEqual(inserts(), [{ task: "backup", outcome: "threw", reason: "R2 said no" }]);
  assert.ok(errors.lines.some((l) => JSON.parse(l).message.startsWith("BACKUP_CRON_THREW R2 said no")), errors.lines.join("\n"));
});

test("PLANT: a tick step's throw is recorded and does not stop the steps after it", async () => {
  const { env, inserts } = ledgerEnv();
  const errors = capture("error");
  let after = false;
  try {
    const value = await runTask(env, "auto-merge", async () => { throw new Error("GitHub 502"); }, () => null, { tag: "AUTO_MERGE_THREW:", rethrow: false });
    assert.equal(value, null);
    await runTask(env, "watcher", async () => (after = true), () => ({ outcome: "ok", reason: "pass" }), { tag: "WATCHER_THREW:", rethrow: false });
  } finally {
    errors.restore();
  }
  assert.ok(after, "the step after the throw did not run");
  assert.deepEqual(inserts(), [
    { task: "auto-merge", outcome: "threw", reason: "GitHub 502" },
    { task: "watcher", outcome: "ok", reason: "pass" },
  ]);
  assert.ok(errors.lines.some((l) => JSON.parse(l).message.startsWith("AUTO_MERGE_THREW: GitHub 502")));
});

test("PLANT: a ledger that cannot be written never stops the task, and says so in the log", async () => {
  const { env } = ledgerEnv({ refuse: "no such table: task_runs" });
  const errors = capture("error");
  let value: number | null;
  try {
    value = await runTask(env, "tick", async () => 1, () => ({ outcome: "ok", reason: "x" }), { tag: "T", rethrow: true });
  } finally {
    errors.restore();
  }
  assert.equal(value, 1);
  assert.deepEqual(errors.lines.map((l) => JSON.parse(l)), [
    { event: "TASK_RUN_UNRECORDED", message: "TASK_RUN_UNRECORDED tick ok: no such table: task_runs" },
  ]);
});

test("a reason is kept to one line of at most REASON_MAX characters", async () => {
  const { env, inserts } = ledgerEnv();
  await runTask(env, "tick", async () => 0, () => ({ outcome: "ok", reason: `a\n  b ${"x".repeat(900)}` }), { tag: "T", rethrow: true });
  const reason = String(inserts()[0].reason);
  assert.equal(reason.length, REASON_MAX);
  assert.ok(reason.startsWith("a b x"));
  assert.ok(!reason.includes("\n"));
});

// ---- flags ----------------------------------------------------------------------

const NOW = new Date("2026-10-01T12:00:00Z");
const run = (minutesAgo: number, outcome: OpsTaskRun["outcome"] = "ok"): OpsTaskRun => {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return { started_at: at, finished_at: at, outcome, reason: "r" };
};
const flags = (runs: Partial<Record<TaskId, OpsTaskRun[]>>, cadence = 30) =>
  Object.fromEntries(taskStates(new Map(Object.entries(runs) as [TaskId, OpsTaskRun[]][]), NOW, cadence).map((t) => [t.id, t.flag]));

test("every task is listed, and one with no run is 'never'", () => {
  const states = taskStates(new Map(), NOW, 30);
  assert.deepEqual(states.map((t) => t.id), TASKS.map((t) => t.id));
  assert.ok(states.every((t) => t.flag === "never" && t.recent.length === 0));
});

test("PLANT: a task whose newest run threw or was refused is failing, whatever came before", () => {
  const f = flags({ backup: [run(60, "threw"), run(1500)], "auto-merge": [run(5, "refused")], "skills-refresh": [run(60, "skipped")] });
  assert.equal(f.backup, "failing");
  assert.equal(f["auto-merge"], "failing");
  assert.equal(f["skills-refresh"], null, "a skip is shown, not flagged");
});

test("PLANT: a periodic task is quiet after twice its period and not before", () => {
  assert.equal(flags({ tick: [run(9)] }).tick, null);
  assert.equal(flags({ tick: [run(11)] }).tick, "quiet");
  assert.equal(flags({ backup: [run(47 * 60)] }).backup, null);
  assert.equal(flags({ backup: [run(49 * 60)] }).backup, "quiet");
});

test("the watcher's period is its own cadence, read from its snapshot", () => {
  assert.equal(flags({ watcher: [run(50)] }, 30).watcher, null);
  assert.equal(flags({ watcher: [run(61)] }, 30).watcher, "quiet");
  assert.equal(flags({ watcher: [run(61)] }, 60).watcher, null);
});

test("a task whose runs follow the work is never quiet, only failing", () => {
  for (const t of TASKS.filter((t) => t.period_ms === null && t.id !== "watcher")) {
    assert.equal(flags({ [t.id]: [run(60 * 24 * 30)] })[t.id], null, t.id);
  }
});
