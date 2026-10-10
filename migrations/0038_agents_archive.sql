-- REVOKED AGENTS LEAVE THE LIVE LIST AND KEEP THEIR HISTORY (job_24e460427d6c; Dustin,
-- 2026-10-02 and 2026-10-10: archive and hide, never delete an agent with history).
--
-- WHY A TABLE. A revoked agent kept its row in agents forever, so the Agents view and
-- every inventory read listed watcher and the spent runner keys beside the live
-- credentials. The rows that describe what an agent did (audit_log.actor,
-- jobs.posted_by and claimed_by, job_outcomes.agent, job_claims.agent,
-- job_touches.actor, agent_sessions.agent) all carry the actor string agent:<name>
-- themselves, so none of them needs the agents row to make sense. What still needs it
-- moves here with it: the name, which stays reserved; the key's sha256, so a revoked
-- key is still refused rather than tried as an operator key; and the scopes, so a
-- reviewer's past verdict is judged on the flags it held.
--
-- WHEN. The watcher pass moves a revoked agent 7 days after revocation, and a runner
-- key bound to one job (job_id set) on the first pass after its job ended
-- (src/agents-archive.ts). Each move is one batch: insert here, delete from agents,
-- one audit_log row.
--
-- Additive: one new table. Applied by the seat; CI's deploy refuses to ship while it
-- is missing.

CREATE TABLE IF NOT EXISTS agents_archive (
  -- The agents row's columns, copied unchanged.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  last_seen TEXT,
  job_id TEXT,
  -- Which rule moved it: 'revoked-7-days' or 'runner-job-ended'.
  reason TEXT NOT NULL CHECK (reason IN ('revoked-7-days', 'runner-job-ended')),
  -- Counted at the move, from audit_log rows whose actor is agent:<name> and from jobs
  -- it posted or holds plus job_outcomes rows it ended. A snapshot, never updated.
  audit_rows INTEGER NOT NULL,
  jobs INTEGER NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
