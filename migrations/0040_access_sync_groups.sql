-- THE ACCESS GROUP EACH APP'S MEMBERS PAGE KEEPS IN STEP (job_d0fabaadecb1; Dustin's
-- rulings of 2026-10-09, people and roles, points 1 and 2; docs/design/design-identity-roles.md,
-- "The Cloudflare sync").
--
-- WHY A TABLE. POST /ops/access-sync writes an app's Cloudflare Access group with
-- Capsid's token, the only copy of it. The caller never names the group: Capsid looks it
-- up here by the namespace the caller's key holds write on, so a key reaches its own app's
-- group alone. Before every write the group is read and its name must equal group_name,
-- so a wrong or reused id refuses instead of overwriting someone else's list
-- (src/access-sync.ts).
--
-- WHO WRITES IT. The seat, by hand, once per app when the app adopts the members page,
-- after Dustin creates the group in Zero Trust. No tool and no route writes it. The insert
-- for the lab, once its group exists:
--   INSERT INTO access_sync_groups (namespace, group_id, group_name, pinned_by)
--   VALUES ('dustinedwards', '<group id from Zero Trust>', 'lab-people', 'access:<seat email>');
--
-- Additive: one new table, no seed rows. Applied by the seat; CI's deploy refuses to ship
-- while it is missing.

CREATE TABLE IF NOT EXISTS access_sync_groups (
  -- The Capsid namespace the app's key is minted for. One group per namespace.
  namespace TEXT PRIMARY KEY,
  -- The Access group's id (a UUID in Zero Trust > Access controls > Rule groups).
  group_id TEXT NOT NULL UNIQUE,
  -- The group's name as Cloudflare shows it; checked before every write.
  group_name TEXT NOT NULL,
  -- Who pinned it, as an actor string (access:<email>), and when.
  pinned_by TEXT NOT NULL,
  pinned_at TEXT NOT NULL DEFAULT (datetime('now'))
);
