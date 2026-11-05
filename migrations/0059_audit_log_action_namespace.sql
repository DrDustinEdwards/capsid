-- audit_log (action, namespace, id DESC): the auto-merged lookups in merge-units.ts and merge-safety.ts filter by
-- action and namespace and take the newest row. Only audit_log_action_actor (action, actor) could serve them, so
-- each call read every auto-merged row: 5.2K calls and 38.7M rows read in 7 days (D1 counts rows scanned,
-- developers.cloudflare.com/d1/platform/pricing/). Additive: one index, no row touched.
CREATE INDEX IF NOT EXISTS audit_log_action_ns_recent ON audit_log (action, namespace, id DESC);
