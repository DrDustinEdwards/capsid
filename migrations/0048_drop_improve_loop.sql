-- The improve loop's and the stored skills' tables, dropped. The loop and the skill
-- machinery were removed from the code on 2026-10-19 (Dustin: "we should just remove
-- those things"; capsid/rulings/remove-improve-loop-2026-10-19.md), and nothing has
-- read or written these tables since that deploy. Dustin chose the drop the same day.
--
-- NOT ADDITIVE. It contains DROP TABLE, so src/gate-policy.ts isAdditiveMigration
-- refuses it and it is applied by hand, before the deploy that carries the matching
-- src/backup.ts TABLES (the nightly dump refuses a schema that disagrees with TABLES).
--
-- WHAT IT LOSES. Two rows in all on the live database: one improve_skills row and one
-- skill_evaluations row, exported before the drop. Every other table was empty. The
-- nightly dumps before this migration still hold the tables. Dropping a table drops its
-- indexes (0003, 0005, 0012, 0013, 0018); none had a trigger or a foreign key.
--
-- KEPT: improve_jti (0004), the replay table of the bench and the backup credential.
-- Idempotent: IF EXISTS, so a second run is a no-op.

DROP TABLE IF EXISTS improve_scores;
DROP TABLE IF EXISTS improve_attempts;
DROP TABLE IF EXISTS improve_runs;
DROP TABLE IF EXISTS improve_skills;
DROP TABLE IF EXISTS skill_evaluations;
DROP TABLE IF EXISTS skill_edits;
DROP TABLE IF EXISTS skill_failures;
