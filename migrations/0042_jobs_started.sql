-- A STARTED LABEL, NOT A LEASE (job_e68de044f8a4; Dustin, 2026-10-10, plan step 2).
-- A cloud session signs in as the admin login and works a job without claiming it, so
-- a second session had no way to see that somebody was already on it. capsid_work_jobs
-- action "begin" marks a queued job started: who, and when. The label never expires
-- and never refuses anything. Claim, complete and every other transition read past it;
-- it only tells the next reader who started the job and when. Written by
-- src/jobs-begin.ts.
--
-- Additive: two nullable columns. Applied by the seat; CI's deploy refuses to ship
-- while it is missing.

ALTER TABLE jobs ADD COLUMN started_at TEXT;
ALTER TABLE jobs ADD COLUMN started_by TEXT;
