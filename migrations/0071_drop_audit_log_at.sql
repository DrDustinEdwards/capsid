-- contract: audit_log_at (at) is a prefix of audit_log_at_actor_action (at, actor, action), added in 0070, so every
-- read it served uses the new index (Dustin, 2026-11-26, approved on a decision card). No row is touched.
--
-- Hand run (a drop): applied 2026-11-27 after a D1 Time Travel bookmark (00006f5e-00000000-00005130-fb86fb0139ccfb4af364c9671833f565),
-- with its d1_migrations row.
DROP INDEX IF EXISTS audit_log_at;
