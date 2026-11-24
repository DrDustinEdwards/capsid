-- contract: job_claims keeps the claim as sent (raw) and its identity. The seventeen typed columns
-- (PR lists and counts, tests, deploy state, files touched, versions) repeated raw, which already
-- holds every value (Dustin, 2026-11-24, from the database audit). Counted before the drop: 719 rows,
-- and no row had a typed value that raw lacked. The code stopped writing them in #1066.
--
-- Hand run (a drop): applied 2026-11-24 after a D1 Time Travel bookmark, with its d1_migrations row.
ALTER TABLE job_claims DROP COLUMN prs_opened_urls;
ALTER TABLE job_claims DROP COLUMN prs_merged_urls;
ALTER TABLE job_claims DROP COLUMN prs_opened;
ALTER TABLE job_claims DROP COLUMN prs_merged;
ALTER TABLE job_claims DROP COLUMN commits;
ALTER TABLE job_claims DROP COLUMN files_changed;
ALTER TABLE job_claims DROP COLUMN tests_added;
ALTER TABLE job_claims DROP COLUMN tests_run;
ALTER TABLE job_claims DROP COLUMN tests_passed;
ALTER TABLE job_claims DROP COLUMN tests_failed;
ALTER TABLE job_claims DROP COLUMN tests_result;
ALTER TABLE job_claims DROP COLUMN deploy_state;
ALTER TABLE job_claims DROP COLUMN files_touched;
ALTER TABLE job_claims DROP COLUMN model_id;
ALTER TABLE job_claims DROP COLUMN client_name;
ALTER TABLE job_claims DROP COLUMN client_version;
ALTER TABLE job_claims DROP COLUMN permission_mode;
