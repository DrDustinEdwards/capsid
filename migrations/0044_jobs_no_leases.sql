-- CLAIM LEASES ARE GONE (job_2c92174d5bff item 1). Cloud sessions no longer claim jobs:
-- a routine fires a session, the job is marked started (migrations/0042, src/jobs-begin.ts)
-- and the session completes it by naming its pull request. The lease that bounded a
-- claim, the heartbeat that extended it and the five-minute sweep that returned an
-- expired claim to the queue are removed from the Worker.
--
-- Every job still claimed becomes a queued job marked started by its holder, which is
-- what it already was: somebody working it. A runner key bound to one of these jobs is
-- revoked first (the run that held it is over). claimed_at is kept, so the job's
-- duration still runs from its first claim.
--
-- jobs.lease_expires stays as a column nothing reads or writes: dropping a column in D1
-- is risky, and the value is cleared on every row so a stale lease cannot be read as
-- live. agents.scopes JSON may still carry a max_claims key; it is ignored.
--
-- Data only, no schema change. Applied by the seat; CI's deploy refuses to ship while
-- it is missing.

UPDATE agents SET revoked_at = datetime('now')
  WHERE revoked_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE status = 'claimed');

UPDATE jobs SET
    status = 'queued',
    started_by = COALESCE(started_by, claimed_by),
    started_at = COALESCE(started_at, updated_at),
    claimed_by = NULL,
    lease_expires = NULL
  WHERE status = 'claimed';

UPDATE jobs SET lease_expires = NULL WHERE lease_expires IS NOT NULL;
