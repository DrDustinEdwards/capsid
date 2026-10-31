-- EVERY HOST THE FAMILY SERVES, AND DUSTINEDWARDS ON ITS FAMILY HEALTH ROUTE (area 8,
-- 2026-10-31, the verifier's gaps "Fix first" 1 and U1). Each was read with curl on
-- 2026-10-31:
--   dustinedwards       /health answers 200 pass; /api/health answered 503 on drift while the
--                       site was up, so the watcher (and the push) called it failing.
--                       /api/health stays the site's drift-repair route, not its probe.
--   capsid              the seeded origin capsid.dustin-edwards.workers.dev answers Cloudflare
--                       error 1042; the Worker serves https://mcp.dustinedwards.info/health. The
--                       live row was already moved in the Portal; this brings the seed along.
--                       self_probe goes to 0 as a Portal edit of the origin would set it.
--   capsomer, enarratio static sites with no health route (their /health is 404), probed at
--                       the root. They were added in the Portal; recorded here so a fresh
--                       install has them.
-- Further hosts of a namespace, each keyed <namespace>-<host> (src/ops-sites.ts
-- owningNamespace, so the site-map check does not call them unregistered):
--   dustinedwards-prelum     https://prelum.dustinedwards.info, Prelum's static specimen, root
--   capsid-portal            https://portal.dustinedwards.info, behind Access: the root
--                            follows the redirect to the sign-in, which proves the host and
--                            Access answer. The Portal is the capsid Worker, so its health is
--                            the capsid row's.
--   foxhound-admin-mcp       https://admin-mcp.foxhoundapp.com/health, 200 {"ok":true,"sha"}
--   dustinedwards-admin-mcp  https://admin-mcp.dustinedwards.info/health, 200 text "ok"
--   foxing-admin-mcp         https://admin-mcp.foxing.app/health, 404 from a Vercel app today:
--                            its route is not deployed (foxing/mcp/wrangler.jsonc.example), so
--                            this row reads down until it is, which is the point.
--
-- Each UPDATE changes only a row still as an earlier seed left it, so a Portal edit since
-- is kept, and bumps the revision so a Portal preview read before it is refused. INSERT OR
-- IGNORE keeps any row already there. Applying the file twice changes nothing.

UPDATE ops_sites SET health_path = '/health', revision = revision + 1, updated_at = datetime('now')
  WHERE namespace = 'dustinedwards' AND health_path = '/api/health';

UPDATE ops_sites SET origin = 'https://mcp.dustinedwards.info', self_probe = 0, revision = revision + 1, updated_at = datetime('now')
  WHERE namespace = 'capsid' AND origin = 'https://capsid.dustin-edwards.workers.dev';

INSERT OR IGNORE INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES
  ('capsomer', 'Capsomer', 'https://capsomer.dustinedwards.info', NULL, 'cloudflare', NULL, 0),
  ('enarratio', 'Enarratio', 'https://enarratio.dustinedwards.info', NULL, 'cloudflare', NULL, 0),
  ('dustinedwards-prelum', 'Prelum', 'https://prelum.dustinedwards.info', NULL, 'cloudflare', NULL, 0),
  ('capsid-portal', 'Capsid Portal', 'https://portal.dustinedwards.info', NULL, 'cloudflare', NULL, 0),
  ('foxhound-admin-mcp', 'Foxhound Admin MCP', 'https://admin-mcp.foxhoundapp.com', '/health', 'cloudflare', NULL, 0),
  ('dustinedwards-admin-mcp', 'dustinedwards.info Admin MCP', 'https://admin-mcp.dustinedwards.info', '/health', 'cloudflare', NULL, 0),
  ('foxing-admin-mcp', 'Foxing Admin MCP', 'https://admin-mcp.foxing.app', '/health', 'cloudflare', NULL, 0);
