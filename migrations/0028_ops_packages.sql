-- The packages Capsid Portal watches, configured in the Portal like its sites
-- (migrations/0022). Ruling: capsid/decisions.md, 2026-09-29, "Portal monitoring is
-- optional and configured per install; packages panel approved". With no row, the
-- Portal shows no Packages view and the watcher reads nothing for packages.
--
-- One row per npm package. repo is the GitHub repository whose stars, issues, pull
-- requests and releases the panel shows, or NULL. formerly is an earlier npm name whose
-- download history is shown joined to this one (enarratio was abscissa until
-- 2026-09-29). revision counts edits, as ops_sites.revision does: an edit or a removal
-- names the revision its preview read and is refused if the row changed since.
--
-- ops_package_weeks keeps the GitHub numbers once per ISO week and package, the only
-- series stored: npm keeps its own download history, fetched on demand.
--
-- Additive: two new tables and no seed. The first package is added from the Portal.

CREATE TABLE IF NOT EXISTS ops_packages (
  name TEXT PRIMARY KEY,
  registry TEXT NOT NULL DEFAULT 'npm' CHECK (registry = 'npm'),
  repo TEXT,
  formerly TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (formerly IS NULL OR formerly <> name)
);

CREATE TABLE IF NOT EXISTS ops_package_weeks (
  name TEXT NOT NULL,
  -- ISO 8601 week, "2026-W40".
  week TEXT NOT NULL,
  repo TEXT NOT NULL,
  stars INTEGER NOT NULL,
  -- Issues only: GitHub counts pull requests as issues, so the open pull requests are
  -- taken out of open_issues_count before it is stored.
  open_issues INTEGER NOT NULL,
  open_prs INTEGER NOT NULL,
  latest_release TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, week)
);
