-- REMOVE WHAT NOTHING READS OR WRITES (Dustin, 2026-11-24, from the database audit).
-- contract: nothing reads or writes any of these; agents_archive's rows are in agents since
-- 0066, and the other columns held no data. Dumps before this migration still carry them.
--
-- Hand run: it drops, so CI's migration check refuses it (docs/autonomy.md).
DROP TABLE agents_archive;
DROP INDEX IF EXISTS agents_job;
ALTER TABLE agents DROP COLUMN job_id;
ALTER TABLE documents DROP COLUMN frontmatter;
ALTER TABLE documents DROP COLUMN publish_at;
ALTER TABLE job_outcomes DROP COLUMN cost_usd;
ALTER TABLE job_outcomes DROP COLUMN tokens_input;
ALTER TABLE job_outcomes DROP COLUMN tokens_output;
ALTER TABLE job_outcomes DROP COLUMN tokens_cache_read;
ALTER TABLE job_outcomes DROP COLUMN tokens_cache_creation;
ALTER TABLE job_outcomes DROP COLUMN active_seconds;
