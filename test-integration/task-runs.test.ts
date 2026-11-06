import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readTaskRuns, RUN_RETENTION_DAYS, RUNS_PER_TASK, taskRunStatements } from "../src/task-runs";

// The run ledger against a real D1 with every migration applied
// (migrations/0029_task_runs.sql): the insert, the bounded prune, the schema's own
// check, and the per-task read the Portal makes. test/task-runs.test.ts covers the
// recorder and the flags without a database.

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 86_400_000;

async function write(task: "tick" | "backup", at: Date, outcome: "ok" | "threw" = "ok", reason = "r") {
  await env.DB.batch(taskRunStatements(env.DB, task, at, at, outcome, reason));
}

describe("the run ledger against real D1", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM task_runs").run();
  });

  it("each task's newest runs come back newest first, at most RUNS_PER_TASK, and other tasks' rows stay out", async () => {
    for (let i = 0; i < RUNS_PER_TASK + 2; i++) await write("tick", new Date(NOW.getTime() + i * 300_000), "ok", `tick ${i}`);
    await write("backup", NOW, "threw", "R2 said no");

    const runs = await readTaskRuns(env.DB);
    const tick = runs.get("tick")!;
    expect(tick.map((r) => r.reason)).toEqual(["tick 6", "tick 5", "tick 4", "tick 3", "tick 2"]);
    expect(runs.get("backup")).toEqual([{ started_at: NOW.toISOString(), finished_at: NOW.toISOString(), outcome: "threw", reason: "R2 said no" }]);
    expect(runs.get("watcher")).toEqual([]);
  });

  it("PLANT: a write prunes rows past retention and keeps the rest", async () => {
    const old = new Date(NOW.getTime() - (RUN_RETENTION_DAYS + 1) * DAY);
    const kept = new Date(NOW.getTime() - (RUN_RETENTION_DAYS - 1) * DAY);
    await write("tick", old, "ok", "old");
    await write("tick", kept, "ok", "kept");
    await write("tick", NOW, "ok", "new");
    const { results } = await env.DB.prepare("SELECT reason FROM task_runs ORDER BY id").all<{ reason: string }>();
    expect(results.map((r) => r.reason)).toEqual(["kept", "new"]);
  });

  it("the schema refuses an outcome that is not one of the four", async () => {
    await expect(
      env.DB.prepare("INSERT INTO task_runs (task, started_at, finished_at, outcome, reason) VALUES ('tick', 'a', 'b', 'fine', 'r')").run()
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
