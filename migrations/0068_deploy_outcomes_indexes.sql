-- deploy_outcomes indexes for the reads that name no repo (Dustin, 2026-11-24, from the database audit;
-- the plan check in test-integration/query-plans.test.ts found each as a bare table scan). It is the
-- largest table nothing pruned until now: the DORA, merge-safety and merge-units reads filter by run_at,
-- the digest and push reads by outcome and recorded_at, and the one index it had leads with repo.
-- Additive: two indexes, no row touched.
CREATE INDEX IF NOT EXISTS deploy_outcomes_run_at ON deploy_outcomes (run_at);
CREATE INDEX IF NOT EXISTS deploy_outcomes_outcome ON deploy_outcomes (outcome, recorded_at);
