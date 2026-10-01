-- THE RUN LEDGER (capsid/decisions.md 2026-09-30, "admin panels review adopted",
-- item 1; job_fe0da37c07e0 PR 1).
--
-- WHAT WAS MISSING. Every scheduled task (the backup, the improve opener, the skills
-- refresh, the five-minute tick and the steps it carries) reported its outcome with
-- console.log and console.error only. A task that skipped, was refused or threw was
-- visible in Workers logs and nowhere else, so the Portal could not show it.
--
-- WHAT THIS TABLE IS. One row per run of a scheduled task: which task, when it
-- started and finished, its outcome, and a one-line reason saying what the run did
-- or why it did not. src/task-runs.ts writes it and is the only writer. A step that
-- was not due (the watcher between passes, the daily sweep before its day) is not a
-- run and writes nothing. Pruned at 14 days in code, a bounded batch per write, so
-- it stays small.
--
-- Additive: one new table and its index.

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'skipped', 'refused', 'threw')),
  reason TEXT NOT NULL
);

-- The Portal's read: each task's newest runs, by id.
CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs (task, id);
