-- PORTAL SIGN-OUT ON THE SERVER (area 3, 2026-10-31). The Portal's session cookie is a
-- signed assertion carrying a random session id (src/portal-auth.ts). Sign out and the
-- idle end record that id here, and a cookie carrying it is refused, so a copy of the
-- cookie taken elsewhere ends with it while the person's other sessions go on. Sessions
-- live in D1, never KV (D9). Times are epoch milliseconds; `expires_at` is when the
-- cookie could no longer be sent anyway, and the nightly backup prunes rows past it
-- (src/backup.ts).
CREATE TABLE IF NOT EXISTS portal_session_ends (
  sid TEXT PRIMARY KEY NOT NULL,
  ended_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= ended_at)
);
CREATE INDEX IF NOT EXISTS portal_session_ends_expires ON portal_session_ends (expires_at);
