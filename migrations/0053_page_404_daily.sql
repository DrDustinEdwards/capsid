-- CAPSID'S OWN 404s (area 8, N1 and N7, 2026-10-31): site-runtime's counter, the table every
-- family site keeps (@dustinedwards/site-runtime/not-found NOT_FOUND_SQL, verbatim). One row
-- per UTC day, path and referring host: only the pathname (never the query) and the host of
-- the Referer, no address or user agent. `kind` is "probe" for a path a scanner guesses
-- (NOT_FOUND_PROBE), else "page". Written by countNotFound in src/index.ts, pruned at 90
-- days by the nightly backup after its dump (src/backup.ts).
CREATE TABLE IF NOT EXISTS page_404_daily (
  id TEXT PRIMARY KEY NOT NULL,
  day INTEGER NOT NULL,
  path TEXT NOT NULL,
  referrer_host TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'page',
  hit_count INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS page_404_daily_day_path_referrer_uq ON page_404_daily (day, path, referrer_host);
