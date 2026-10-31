-- THE HOSTS NOTHING WATCHED (area 8, U1, 2026-10-31, round 2): the explorer, Desk and
-- txasm.org. Each is a further host of a registered namespace, keyed <namespace>-<host>
-- (src/ops-sites.ts owningNamespace), so the site-map check does not call it unregistered.
--   capsid-explorer  https://capsid.dustinedwards.info, the explorer: static assets on its
--                    own Worker, no health route, so the probe reads the root.
--   carrel-desk      https://desk.dustinedwards.info/health: Desk's own Worker
--                    (carrel-desk), behind Access except /health, which Desk serves with
--                    its own sha once its Access bypass app exists.
--   txasm-org        https://txasm.org, still the WordPress site until cutover: the root
--                    says whether the public address answers. Its Cloudflare read stays
--                    unresolved, and its certificate unread, until the zone moves.
-- INSERT OR IGNORE keeps any row already there, so a Portal edit is kept and applying the
-- file twice changes nothing.

INSERT OR IGNORE INTO ops_sites (namespace, name, origin, health_path, platform, script, self_probe) VALUES
  ('capsid-explorer', 'Capsid explorer', 'https://capsid.dustinedwards.info', NULL, 'cloudflare', NULL, 0),
  ('carrel-desk', 'Desk', 'https://desk.dustinedwards.info', '/health', 'cloudflare', NULL, 0),
  ('txasm-org', 'txasm.org', 'https://txasm.org', NULL, 'cloudflare', NULL, 0);
