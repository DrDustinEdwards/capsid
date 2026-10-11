-- THE UNIT OF EACH APPROVAL (docs/design/design-merge-pipeline.md section 7, PR 9). A unit is
-- (namespace, path class), and promotion counts approved merges per unit, so each approval
-- records the namespace it was given in and the path class the tick gave the pull request
-- when it was approved (src/merge-class.ts). Rows written before this migration have
-- neither and count toward no unit. Read by src/merge-units.ts.
--
-- Additive: two nullable columns, no rewrite of existing rows. Applied by the seat.

ALTER TABLE pr_approvals ADD COLUMN namespace TEXT;
ALTER TABLE pr_approvals ADD COLUMN path_class TEXT;
