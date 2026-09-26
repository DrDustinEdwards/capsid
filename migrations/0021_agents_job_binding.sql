-- A RUNNER KEY IS BOUND TO ONE JOB (capsid/research/design-seat-session-hardening.md,
-- section 2; approved 2026-09-26).
--
-- WHAT WAS WRONG. A seat-started session on GitHub's runners authenticated with a
-- long-lived key per repo, stored as a repository secret. Code a session writes can
-- read that key, and the key could claim and work any job in its namespace for as
-- long as nobody revoked it by hand.
--
-- WHAT THIS COLUMN SAYS. The job a minted key exists to work, or NULL for every other
-- agent. src/agents.ts resolves a bound key only while that job is live for it
-- (claimed by it under an unexpired lease, or queued within the pending-start
-- window), so its lifetime is the lease's and there is no second clock to drift.
-- src/scope.ts refuses it any jobs call on another job. The key itself is minted by
-- the /ops/runner-key exchange, which lands separately.
--
-- A COLUMN, NOT A SCOPES FIELD. The resolver reads it on every request and the
-- in-flight count queries by it; the scopes JSON is parsed, not queried.
--
-- NOT IDEMPOTENT, like 0007, 0009, 0011, 0012, 0016 and 0017: wrangler runs each
-- migration file exactly once and SQLite has no ADD COLUMN IF NOT EXISTS. Additive:
-- every existing row reads NULL, which is an unbound agent, which is what each is.

ALTER TABLE agents ADD COLUMN job_id TEXT;

CREATE INDEX IF NOT EXISTS agents_job ON agents (job_id) WHERE job_id IS NOT NULL;
