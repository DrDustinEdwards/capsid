-- THE METHODS PAPER'S PAIRED COMPARISON (job_ecb1b5f80c2d; capsid/research/design-paired-comparison.md,
-- section 2). The capsid-bench repo runs one task per job per arm and reports here
-- through three signed endpoints (src/bench.ts). These two tables are what the paper's
-- primary outcome, the false success claim, is computed from.
--
-- EVIDENCE, SO THE DATABASE KEEPS IT FIXED, as for the claims tables (0023):
--   bench_tasks  insert-only. A task is registered once with its hidden test counts, and
--                the list registered on OSF is then the list scored here. No UPDATE; a
--                DELETE only while no run names the task.
--   bench_runs   one row per run. It is opened 'running' and closed exactly once, to
--                'scored' or 'unjudged'; a closed row never changes and no row is deleted.
--
-- NULL IS NOT FALSE, on 0011's reasoning: an outcome not computed (an unjudged run) is
-- NULL, never 0.
--
-- Additive: two new tables, their indexes and triggers. Nothing existing changes.

CREATE TABLE IF NOT EXISTS bench_tasks (
  -- The benchmark's own instance id, or own:<repo>#<pr> for a real task.
  task_id TEXT PRIMARY KEY,
  -- swe-rebench | swe-bench-live | own
  source TEXT NOT NULL CHECK (source IN ('swe-rebench', 'swe-bench-live', 'own')),
  -- pilot | full | excluded. The pilot's tasks are kept out of the full run.
  split TEXT NOT NULL CHECK (split IN ('pilot', 'full', 'excluded')),
  repo TEXT NOT NULL,
  -- When the issue was opened, as the source states it: the post-cutoff rule reads it.
  issue_created_at TEXT NOT NULL,
  -- How many hidden tests the scorer must report, so a suite that did not fully run is
  -- unjudged rather than scored as a fail.
  fail_to_pass_count INTEGER NOT NULL CHECK (fail_to_pass_count > 0),
  pass_to_pass_count INTEGER NOT NULL CHECK (pass_to_pass_count >= 0),
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bench_runs (
  -- bench_<12 hex>, minted by the Worker at start.
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  -- baseline | treatment, and the two planted arms that call no model and check the
  -- harness: check-gold (the upstream fix, must be resolved) and check-false-claim (an
  -- empty diff claiming done, must be a false claim).
  arm TEXT NOT NULL CHECK (arm IN ('baseline', 'treatment', 'check-gold', 'check-false-claim')),
  -- The GitHub Actions run that holds it, "<run_id>.<attempt>", for the log.
  gh_run TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'scored', 'unjudged')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- The treatment's Capsid job, whose status is its claim.
  capsid_job_id TEXT,
  claimed_done INTEGER,
  resolved INTEGER,
  false_claim INTEGER,
  fail_to_pass_passed INTEGER,
  pass_to_pass_passed INTEGER,
  unjudged_reason TEXT,
  model TEXT,
  claude_code_version TEXT,
  -- Claude Code's own report: total_cost_usd is a client-side API-rate estimate.
  cost_usd REAL,
  turns INTEGER,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  image_bytes INTEGER,
  -- The score report as it arrived, JSON.
  report TEXT
);

-- The concurrency cap counts running rows by start time.
CREATE INDEX IF NOT EXISTS bench_runs_status ON bench_runs (status, started_at);
CREATE INDEX IF NOT EXISTS bench_runs_task ON bench_runs (task_id, arm);

CREATE TRIGGER IF NOT EXISTS bench_tasks_insert_only_update BEFORE UPDATE ON bench_tasks
BEGIN SELECT RAISE(ABORT, 'bench_tasks is insert-only'); END;
CREATE TRIGGER IF NOT EXISTS bench_tasks_frozen_delete BEFORE DELETE ON bench_tasks
WHEN EXISTS (SELECT 1 FROM bench_runs WHERE task_id = OLD.task_id)
BEGIN SELECT RAISE(ABORT, 'bench_tasks: a task with a run is frozen'); END;
CREATE TRIGGER IF NOT EXISTS bench_runs_closed_update BEFORE UPDATE ON bench_runs
WHEN OLD.status != 'running'
BEGIN SELECT RAISE(ABORT, 'bench_runs: a closed run never changes'); END;
CREATE TRIGGER IF NOT EXISTS bench_runs_no_delete BEFORE DELETE ON bench_runs
BEGIN SELECT RAISE(ABORT, 'bench_runs keeps every run'); END;
