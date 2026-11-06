-- Two retired jobs columns and the lease index, dropped (Dustin, 2026-11-06: the cleanup
-- list). Nothing reads either column; post stored review_required = 0 until this merge.
--
--   jobs.lease_expires (0006): the claim lease, removed 2026-10-11 (migrations/0044 cleared
--   it on every row). Its index jobs_lease (0006) served the lease sweep, which went with it.
--   jobs.review_required (0017): the review gate, removed 2026-10-31 with capsid_open_pr.
--   Every job since stores 0.
--
-- contract: both columns belong to removed features; the nightly dumps before this
-- migration still hold their values.
--
-- NOT ADDITIVE. It drops columns, so src/gate-policy.ts isAdditiveMigration refuses it,
-- and the deploy's `devkit-migrations --apply` refuses it and stops the deploy. It is
-- applied by hand just before the merge that carries the matching code. The Worker deployed
-- before that merge still names review_required in post's INSERT and in list's columns, so
-- both fail from the apply until the deploy lands: apply, then merge at once.
-- The index goes first: SQLite refuses to drop an indexed column. Neither column is in a
-- trigger, a view, a CHECK or a foreign key.
--
-- jobs_status REPLACES jobs_lease AS THE STATUS INDEX. jobs_lease led with status, and the
-- reads that filter on status alone (the blocked lists of whats-next, inbox, push,
-- manual-steps, overnight-plan and merge-resume, the maintenance and public-stats reads, the
-- watcher's duplicate check) used it for that. Without it, EXPLAIN QUERY PLAN shows each of
-- them scanning jobs (test-integration/query-plans.test.ts, run with jobs on its HOT_TABLES
-- list). Most of them also order or range on updated_at, so that is the second column.
--
-- NOT IDEMPOTENT for the columns: SQLite has no DROP COLUMN IF EXISTS, and wrangler runs
-- each migration file once.

CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, updated_at);
DROP INDEX IF EXISTS jobs_lease;
ALTER TABLE jobs DROP COLUMN lease_expires;
ALTER TABLE jobs DROP COLUMN review_required;
