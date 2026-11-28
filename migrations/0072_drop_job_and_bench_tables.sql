-- contract: the job queue (capsid #1113) and the capsid-bench run path (capsid-bench #151) retired on 2026-11-28, and nothing
-- reads or writes these tables any more. Dustin approved dropping all of them on a decision card (2026-11-28 16:22 UTC):
-- 7,288 rows in all. The nightly d1-dump backup of 2026-11-28 09:00 UTC holds every row (the last job write was 07:00 UTC).
--
-- Hand run (a drop): applied 2026-11-28 after a D1 Time Travel bookmark (00007120-00000000-00005131-d6b7e4aef92d8631b511e27b9b0239fe),
-- with its d1_migrations row. Their indexes and triggers go with them.
DROP TABLE IF EXISTS job_outcome_prs;
DROP TABLE IF EXISTS job_outcomes;
DROP TABLE IF EXISTS job_evaluations;
DROP TABLE IF EXISTS job_claims;
DROP TABLE IF EXISTS job_touches;
DROP TABLE IF EXISTS job_versions;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS pr_approvals;
DROP TABLE IF EXISTS bench_draw;
DROP TABLE IF EXISTS bench_registration;
DROP TABLE IF EXISTS bench_runs;
DROP TABLE IF EXISTS bench_tasks;
