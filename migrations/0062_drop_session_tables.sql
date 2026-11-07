-- The Claude Code hook and telemetry tables, dropped (Dustin, 2026-11-07: "as recommended"
-- on removing the receivers). Nothing in the code has read or written them since PR #856.
--
--   agent_sessions, session_events (0025): the hook receiver's session summaries and tool
--   events. Empty.
--   session_usage (0025): the OTLP receiver's cost, token and active-time points. Empty.
--
-- contract: all three belong to removed features; the nightly dumps before this migration
-- still hold their (empty) rows.
--
-- NOT ADDITIVE. It contains DROP TABLE, so src/gate-policy.ts isAdditiveMigration refuses
-- it, and the deploy's `devkit-migrations --apply` refuses it and stops the deploy. It is
-- applied by hand just before the merge that carries the matching src/backup.ts TABLES
-- (the nightly dump refuses a schema that disagrees with TABLES). Dropping a table drops
-- its indexes (agent_sessions_job, agent_sessions_live, session_events_session,
-- session_events_job, session_usage_job); none had a trigger or a foreign key.
-- Idempotent: IF EXISTS, so a second run is a no-op.

DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS session_events;
DROP TABLE IF EXISTS session_usage;
