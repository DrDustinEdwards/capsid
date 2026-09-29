-- The sites Capsid Portal watches, moved from code (src/ops-sites.ts, OPS_SITES) into
-- configuration edited in the Portal. Ruling: capsid/decisions.md, 2026-09-29,
-- "Portal monitoring is optional and configured per install". With no row that has
-- an origin, the Portal shows no Sites view and the watcher probes nothing.
--
-- One row per namespace. A row with an origin is a site the watcher probes; a row
-- with no origin says the namespace serves no site, so its absence from the probes is
-- a decision rather than an omission (the site-map drift check reads both kinds).
-- revision counts edits: an edit or a removal names the revision its preview read,
-- and is refused if the row changed since.
--
-- Additive: a new table and its seed. Seeded with the entries OPS_SITES and
-- NO_SITE_NAMESPACES held at 44560be, so nothing the Portal shows changes on deploy.
-- INSERT OR IGNORE, so applying it twice changes nothing.

CREATE TABLE IF NOT EXISTS ops_sites (
  namespace TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT,
  health_path TEXT,
  platform TEXT CHECK (platform IS NULL OR platform IN ('cloudflare', 'vercel')),
  script TEXT,
  self_probe INTEGER NOT NULL DEFAULT 0 CHECK (self_probe IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((origin IS NULL) = (platform IS NULL)),
  CHECK (origin IS NOT NULL OR (health_path IS NULL AND script IS NULL AND self_probe = 0))
);

INSERT OR IGNORE INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES
  ('capsid', 'Capsid', 'https://capsid.dustin-edwards.workers.dev', '/health', 'cloudflare', 'capsid', 1),
  ('dustinedwards', 'dustinedwards.info', 'https://dustinedwards.info', '/api/health', 'cloudflare', NULL, 0),
  ('germomics', 'Germomics', 'https://germomics.com', '/health', 'cloudflare', NULL, 0),
  ('foxing', 'Foxing', 'https://foxing.app', NULL, 'cloudflare', NULL, 0),
  ('foxhound', 'Foxhound', 'https://foxhoundapp.com', NULL, 'cloudflare', NULL, 0),
  ('txasm', 'TXASM', 'https://txasm.org', NULL, 'cloudflare', NULL, 0),
  ('bsw', 'BSW', 'https://bsw.dustin-edwards.workers.dev', NULL, 'cloudflare', 'bsw', 0),
  ('julieedwards', 'julieedwards.info', 'https://julieedwards.info', NULL, 'vercel', NULL, 0),
  ('claude-skills', 'claude-skills', NULL, NULL, NULL, NULL, 0);
