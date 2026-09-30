-- THE WATCHER REMEMBERS ITS FINDINGS (job queue: watcher dedupe).
--
-- WHAT WENT WRONG. The watcher's only memory of a finding was an open job with the
-- fingerprint in its title. A job leaves the open set when it is cleared, failed or
-- superseded, and the next pass that still sees the condition posts it again:
-- ci-red was filed 13 times between 2026-09-20 and 09-23 (its fingerprint carried the
-- head sha, so every red commit was a new finding), and the site-map drift finding
-- was refiled within an hour of the seat superseding it.
--
-- ONE ROW PER FINDING, keyed by fingerprint, kept across jobs:
--   open       a job is (or should be) open for it; each sighting bumps it
--   dismissed  a person ended its job (superseded, or failed as anything but the
--              watcher's own "cleared") while the condition still held; it is not
--              filed again until it has cleared and stayed clear
--   cleared    the owning check ran and did not see it; cleared_at says when
-- A cleared or dismissed finding is filed again only when it is seen after staying
-- clear until reopen_after (the quiet period, stated in src/watcher-findings.ts).
--
-- Additive: one new table and an index. Nothing existing changes.

CREATE TABLE IF NOT EXISTS watcher_findings (
  fingerprint TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'cleared')),
  -- The job filed for the current episode, if any.
  job_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  -- When the owning check last ran without seeing it. NULL while it is being seen.
  cleared_at TEXT,
  -- The earliest time a sighting may file a new job after a clear or a dismissal.
  reopen_after TEXT,
  -- The newest sightings' evidence, JSON array, bounded in code (newest last).
  evidence TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watcher_findings_state ON watcher_findings (state, namespace);
