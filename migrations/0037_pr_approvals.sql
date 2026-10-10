-- The merge pipeline's approval record (docs/design/design-merge-pipeline.md section 3,
-- PR 3; Dustin's DECIDE of 2026-10-09: approvals void on a new push, red CI or 7 days).
-- One row per approval of one pull request at one head sha. A row starts 'approved' and
-- moves once, by `UPDATE ... WHERE id = ? AND status = 'approved' RETURNING id`, to
-- voided, merged, expired or refused. The executor (the auto-merge tick, PR 4) is the
-- only thing that merges an approved pull request. Read and written by src/pr-approvals.ts.
--
-- Additive: one new table and two indexes.

CREATE TABLE IF NOT EXISTS pr_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL CHECK (repo LIKE '%/%'),
  pr INTEGER NOT NULL CHECK (pr > 0),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  class TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'voided', 'merged', 'expired', 'refused')),
  approved_by TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('portal', 'chat', 'push', 'typed')),
  batch_id TEXT,
  reason TEXT,
  approved_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  merge_sha TEXT
);

-- One open approval per pull request.
CREATE UNIQUE INDEX IF NOT EXISTS pr_approvals_open ON pr_approvals (repo, pr) WHERE status = 'approved';
-- A pull request's history, newest first.
CREATE INDEX IF NOT EXISTS pr_approvals_by_pr ON pr_approvals (repo, pr, id);
