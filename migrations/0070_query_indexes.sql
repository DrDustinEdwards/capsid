-- Indexes for the three slowest reads in Cloudflare's top-queries list for the last 7 days (Dustin, 2026-11-27, D1 index review).
-- documents: the prompt read scanned every body (43 ms for no rows); jobs: the agent-record read scanned every job body;
-- audit_log: the anomaly read walked audit_log_at and fetched each row for actor and action. Each plan checked on a copy of the schema.
-- Additive: three indexes, no row touched.
CREATE INDEX IF NOT EXISTS documents_type_ns_path ON documents (type, namespace, path);
CREATE INDEX IF NOT EXISTS jobs_claimed_by ON jobs (claimed_by, status) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_at_actor_action ON audit_log (at, actor, action);
