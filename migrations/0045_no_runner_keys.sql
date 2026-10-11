-- SEAT-START AND ITS RUNNER KEYS ARE GONE (job_2c92174d5bff item 2). A routine starts a
-- session now (src/routine-fire.ts), with the cloud-driver key from the network secret,
-- so nothing mints a key bound to one job and the Worker no longer resolves one.
--
-- Any key still bound to a job (agents.job_id) is revoked here, so removing the resolver's
-- binding check opens nothing: a bound key that was live is now revoked, the same as one
-- the old resolver would have refused once its job ended.
--
-- agents.job_id and agents_archive.job_id stay as columns nothing writes (dropping a
-- column in D1 is risky). The audit actions job-seat-started and runner-key-minted stay in
-- audit_log as history; nothing writes them.
--
-- Data only, no schema change.

UPDATE agents SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND job_id IS NOT NULL;
