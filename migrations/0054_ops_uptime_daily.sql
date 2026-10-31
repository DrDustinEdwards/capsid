-- DAILY UPTIME PER SITE (area 8, U4, 2026-10-31). The watcher's ring holds seven days of
-- half-hour slots in KV; this keeps a count per site and UTC day for 90 days, so the
-- Portal can show each site against the 99.9% target. The five-minute pulse
-- (src/site-pulse.ts) adds one probe per site per tick: `probes` counts them and `up` the
-- ones that were not down (degraded counts as up: the site answered). Pruned at 90 days by
-- the nightly backup after its dump (src/backup.ts).
CREATE TABLE IF NOT EXISTS ops_uptime_daily (
  namespace TEXT NOT NULL,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  probes INTEGER NOT NULL DEFAULT 0 CHECK (probes >= 0),
  up INTEGER NOT NULL DEFAULT 0 CHECK (up >= 0 AND up <= probes),
  PRIMARY KEY (namespace, day)
);
CREATE INDEX IF NOT EXISTS ops_uptime_daily_day ON ops_uptime_daily (day);
