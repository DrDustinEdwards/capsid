-- The merge pipeline's memory of each deploy (docs/design/design-merge-pipeline.md section
-- 6, PR 6): one row per default-branch CI run whose live gate ran, with what became of the
-- deploy: verified, rolled back, a rollback that did not take effect, a rollback the guard
-- declined, or a gate that failed without a rollback. Written by the watcher from what
-- GitHub reports of the run (src/deploy-outcomes.ts), never by CI, so no CI secret is
-- added. Read by the promotion and demotion proposals (PR 9).
--
-- Additive: one new table and one index.

CREATE TABLE IF NOT EXISTS deploy_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL CHECK (repo LIKE '%/%'),
  namespace TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  pr INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'rolled_back', 'rollback_failed', 'rollback_skipped', 'unverified')),
  rollback_from TEXT,
  rollback_to TEXT,
  detail TEXT,
  run_url TEXT,
  run_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo, run_id)
);

-- A repo's deploys, newest first.
CREATE INDEX IF NOT EXISTS deploy_outcomes_by_repo ON deploy_outcomes (repo, run_at);
