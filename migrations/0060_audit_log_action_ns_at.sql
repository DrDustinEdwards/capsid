-- audit_log (action, namespace, at): the circuit breaker's count in src/job-breaker.ts filters by action, namespace and
-- a time window (`at >= ?2`). The only index it could use, audit_log_action_ns_recent (action, namespace, id DESC), has
-- no time column, so each claim read every job-fail row of the namespace and tested `at` on each: 6,249 rows a call,
-- 440 calls and 4.6M rows read in a day (D1 counts rows scanned, developers.cloudflare.com/d1/platform/pricing/). An
-- index whose last column is `at` turns the window into a range seek, so a call reads only the day's rows
-- (developers.cloudflare.com/d1/best-practices/use-indexes/). Additive: one index, no row touched.
CREATE INDEX IF NOT EXISTS audit_log_action_ns_at ON audit_log (action, namespace, at);
