-- The shared packages the Portal's Shared code view follows (job_584b4e7f2824; ruling
-- capsid/rulings/shared-homes-2026-10-06.md). One row per package: the repo whose tags
-- are its releases, the repo's earlier names (an app still pinned through GitHub's
-- redirect counts), and the known local copies the package replaces, as
-- "namespace:path". Read by src/shared-code.ts; nothing else reads or writes it yet.
--
-- Additive: one new table and its seed, as the shared homes stood on 2026-10-10.

CREATE TABLE IF NOT EXISTS shared_packages (
  name TEXT PRIMARY KEY,
  repo TEXT NOT NULL CHECK (repo LIKE '%/%'),
  formerly TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(formerly) AND json_type(formerly) = 'array'),
  local_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(local_paths) AND json_type(local_paths) = 'array'),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO shared_packages (name, repo, formerly, local_paths) VALUES
  ('Capsomer', 'DrDustinEdwards/capsomer', '[]', '[]'),
  ('site-api', 'DrDustinEdwards/site-api', '[]', '[]'),
  ('d1-dump', 'DrDustinEdwards/d1-dump', '[]', '[]'),
  ('Prelum', 'DrDustinEdwards/prelum', '["DrDustinEdwards/site-helpers"]', '[]'),
  ('site-runtime', 'DrDustinEdwards/site-runtime', '["DrDustinEdwards/security-headers", "DrDustinEdwards/rate-limit"]', '["dustinedwards:packages/security-headers"]'),
  ('devkit', 'DrDustinEdwards/devkit', '["DrDustinEdwards/renovate-config"]', '[]');
