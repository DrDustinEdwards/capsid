-- TIME TO RESTORE (devkit area 12, checklist F4, 2026-11-01). A rolled-back deploy records how
-- long production served it: from the end of its deploy job to the end of the rollback step
-- (src/deploy-outcomes.ts restoreSeconds). With the outcome per run, deploy_outcomes gives each
-- repository DORA's deploy frequency, change failure rate and time to restore (src/trends.ts
-- readDeploys). Null for every other outcome and for rows recorded before this column.
ALTER TABLE deploy_outcomes ADD COLUMN restore_seconds INTEGER CHECK (restore_seconds IS NULL OR restore_seconds >= 0);
