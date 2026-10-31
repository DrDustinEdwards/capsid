-- EVERY LIVE SITE'S HEALTH ROUTE (area 8, 2026-10-30). The seed in 0022 named health
-- routes for capsid, dustinedwards and germomics only, so the watcher read the root of
-- every other site, which proves it is up and nothing more. Each route below was read
-- with curl on 2026-10-30 and answered 200 with a JSON health body:
--   foxing         https://foxing.app/health
--   foxhound       https://foxhoundapp.com/health
--   txasm          https://txasm.dustin-edwards.workers.dev/health, Worker script txasm
--                  as its workers.dev host proves (txasm.org is still
--                  the old WordPress site until cutover, and answers 404 there)
--   bsw            https://bsw.dustin-edwards.workers.dev/health
--   julieedwards   https://julieedwards.info/health, served by Cloudflare, not Vercel
--   carrel         https://carrel-mcp.dustinedwards.info/health, Carrel's public health
--                  route; the app's host is behind Access, and the origin stays the public
--                  page so the live checks and the root fallback read it. A health path
--                  on another host needs the code that reads one (src/ops-sites.ts
--                  healthUrl), so this is applied after that code is deployed.
--
-- Each UPDATE changes only a row still as the seed left it (no health path, the seeded
-- origin or platform), so an edit made in the Portal since is kept, and bumps the revision
-- so a Portal preview read before it is refused. Carrel's row is inserted if it is
-- missing. Applying the file twice changes nothing.

INSERT OR IGNORE INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES
  ('carrel', 'Carrel', 'https://carrel.dustinedwards.info', NULL, 'cloudflare', NULL, 0);

UPDATE ops_sites SET health_path = 'https://carrel-mcp.dustinedwards.info/health', revision = revision + 1, updated_at = datetime('now')
  WHERE namespace = 'carrel' AND origin = 'https://carrel.dustinedwards.info' AND health_path IS NULL;

UPDATE ops_sites SET health_path = '/health', revision = revision + 1, updated_at = datetime('now')
  WHERE namespace IN ('foxing', 'foxhound', 'bsw') AND origin IS NOT NULL AND health_path IS NULL;

UPDATE ops_sites SET origin = 'https://txasm.dustin-edwards.workers.dev', script = 'txasm', health_path = '/health', revision = revision + 1, updated_at = datetime('now')
  WHERE namespace = 'txasm' AND origin = 'https://txasm.org' AND health_path IS NULL;

UPDATE ops_sites SET platform = 'cloudflare', health_path = '/health', revision = revision + 1, updated_at = datetime('now')
  WHERE namespace = 'julieedwards' AND platform = 'vercel' AND health_path IS NULL;
