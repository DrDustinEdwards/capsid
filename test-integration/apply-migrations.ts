import { applyD1Migrations, env } from "cloudflare:test";

// 0001_init.sql's FTS5 table and triggers were never executed by test/, so a migration SQLite rejects
// or a trigger on the wrong column went unseen.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
