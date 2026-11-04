-- Two retired features' tables, dropped (Dustin, 2026-11-03: the cleanup list, "complete
-- all"). Nothing in the code has read or written either since 2026-10-31.
--
--   canon_proposals (0034): the canon review queue, removed 2026-10-31 (src/canon.ts).
--   access_sync_groups (0040): the Access group pins of the Access sync, whose endpoint
--   was removed 2026-10-31. Empty.
--
-- contract: both tables belong to removed features; the nightly dumps before this
-- migration still hold their rows.
--
-- NOT ADDITIVE. It contains DROP TABLE, so src/gate-policy.ts isAdditiveMigration refuses
-- it, and the deploy's `devkit-migrations --apply` refuses it and stops the deploy. It is
-- applied by hand just before the merge that carries the matching src/backup.ts TABLES
-- (the nightly dump refuses a schema that disagrees with TABLES). Dropping a table
-- drops its index (canon_proposals_state); neither had a trigger or a foreign key.
-- Idempotent: IF EXISTS, so a second run is a no-op.

DROP TABLE IF EXISTS canon_proposals;
DROP TABLE IF EXISTS access_sync_groups;
