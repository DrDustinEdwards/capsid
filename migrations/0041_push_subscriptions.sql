-- THE DEVICES THAT GET A PHONE ALERT (docs/design/design-merge-pipeline.md section 5, PR 7;
-- Dustin's DECIDE 5 and 6 of 2026-10-09: Web Push, for four urgent triggers only).
--
-- One row per browser push subscription the administrator turned on from the Portal's
-- Settings (POST /portal/api/push, src/push.ts). The endpoint is a URL on a known push
-- service (src/web-push.ts refuses any other) and the two keys are the browser's: the
-- Worker encrypts each alert to them, so the push service never reads it. A row starts
-- 'active' and moves once, by `UPDATE ... WHERE id = ? AND status = 'active' RETURNING id`,
-- to 'off' (turned off in the Portal) or 'gone' (the push service answered 404 or 410).
--
-- Additive: one new table and one index, no seed rows. Applied by the seat.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL CHECK (endpoint LIKE 'https://%'),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- What the browser said it is, for the Settings list ("Chrome on Android").
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'off', 'gone')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  last_status INTEGER,
  closed_at TEXT
);

-- One live row per endpoint: subscribing the same browser again replaces nothing.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_active ON push_subscriptions (endpoint) WHERE status = 'active';
