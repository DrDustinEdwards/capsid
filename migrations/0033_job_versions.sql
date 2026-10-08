-- EDIT A JOB (job_4ef99d687805, Dustin 2026-10-07; src/jobs-edit.ts).
--
-- A posted job could not be changed: its body is signed, so every correction was a
-- supersede and a repost. jobs action "edit" now changes the title, body, priority or
-- gate_required of a queued or blocked job, and the new body is signed again as post
-- signs it. The row then holds only the new version, so each edit first copies the
-- version it replaces here: who edited, when, and the old title, body (as stored,
-- signed), priority and gate_required. jobs list for one named id returns these rows
-- as versions, newest first, to a caller holding write.
--
-- Additive: one new table and its index, no change to an existing table, no backfill.
-- A job never edited has no rows here.

CREATE TABLE IF NOT EXISTS job_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority INTEGER NOT NULL,
  gate_required INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS job_versions_job ON job_versions (job_id, id);
