-- job_touches gains the kind 'admin_complete': the seat completing a job another
-- credential blocked (src/jobs-seat.ts, PR 250). That close ends the gate's wait like
-- admin_fail does, and until now it wrote no touch because no kind fit it, so a job the
-- seat closed this way read as one that needed no human at all.
--
-- THIS IS A TABLE REBUILD, NOT AN ADDITIVE MIGRATION. kind carries a CHECK, SQLite
-- cannot alter a CHECK, and the only way to widen it is to create the table again, copy
-- the rows, drop the old one and rename. It contains DROP TABLE, so
-- src/gate-policy.ts isAdditiveMigration refuses it and the seat applies it by hand.
--
-- BEFORE APPLYING: take a fresh backup (POST /ops/backup) and note a Time Travel
-- bookmark. job_touches is the human-effort log the methods comparison reads and it is
-- append-only, so a lost row cannot be re-derived.
--
-- WHAT IT KEEPS. Every row, with its id and every column: the copy names the columns
-- and carries id, so AUTOINCREMENT carries on past the highest id and a row keeps the
-- number its readers quote. The job_touches_job index and both append-only triggers are
-- created again after the rename, because dropping the old table drops them.
-- test/job-touches-migration.test.ts runs this file over planted rows and reads them back.
--
-- IF IT STOPS PARTWAY, in order:
--   - before DROP TABLE: job_touches is untouched. DROP TABLE job_touches_new, then run
--     the file again. (CREATE TABLE below has no IF NOT EXISTS on purpose: a leftover
--     scratch table is an earlier failed run and should be seen, not silently reused.)
--   - after DROP TABLE and before the rename: job_touches_new holds every row. Run the
--     last four statements (ALTER TABLE ... RENAME, the index, the two triggers).
--   - after the rename: only the index or a trigger can be missing. Run the CREATE
--     INDEX and CREATE TRIGGER statements below; they are IF NOT EXISTS.
--
-- kinds: gate: the job blocked on a command for someone else. resume: it was sent back.
-- approval: a resume that approved a gated command. correction: a resume that spent a
-- correction. note: a resume note longer than its reason. release, supersede,
-- admin_fail: the seat ended or freed the job. admin_complete: the seat completed a
-- blocked job. review: a REVIEW verdict acted on.

CREATE TABLE job_touches_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gate', 'resume', 'approval', 'correction', 'note', 'release', 'supersede', 'admin_fail', 'admin_complete', 'review')),
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'seat', 'driver', 'policy', 'reviewer', 'system')),
  waited_ms INTEGER,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO job_touches_new (id, job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at)
SELECT id, job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at FROM job_touches;

DROP TABLE job_touches;

ALTER TABLE job_touches_new RENAME TO job_touches;

CREATE INDEX IF NOT EXISTS job_touches_job ON job_touches (job_id, id);

CREATE TRIGGER IF NOT EXISTS job_touches_append_only_update BEFORE UPDATE ON job_touches
BEGIN SELECT RAISE(ABORT, 'job_touches is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_touches_append_only_delete BEFORE DELETE ON job_touches
BEGIN SELECT RAISE(ABORT, 'job_touches is append-only'); END;
