-- REVOKED AGENTS STAY IN agents (Dustin, 2026-11-24, from the database audit: agents_archive
-- was the agents table's own ten columns again, joined back with UNION ALL by three readers).
--
-- An archived agent is now a revoked agents row with archived_at set. The columns that were
-- only on the archive, the reason it moved and the counts taken at the move, are added here
-- and every archived row is copied across with its values.
--
-- Additive: four columns and an insert; no row of agents changes. agents_archive is left in
-- place and unread; the migration that drops it is a hand run (migrations/0067).
ALTER TABLE agents ADD COLUMN archived_at TEXT;
ALTER TABLE agents ADD COLUMN archive_reason TEXT CHECK (archive_reason IN ('revoked-7-days', 'runner-job-ended'));
ALTER TABLE agents ADD COLUMN audit_rows INTEGER;
ALTER TABLE agents ADD COLUMN jobs INTEGER;

INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, last_seen, job_id, archived_at, archive_reason, audit_rows, jobs)
SELECT id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, last_seen, job_id, archived_at, reason, audit_rows, jobs
  FROM agents_archive;
