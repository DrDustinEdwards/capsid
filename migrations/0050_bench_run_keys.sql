-- THE RUN KEY (the methods paper's protocol, section 4; src/bench-run-key.ts). Each
-- treatment run gets its own Capsid key from /bench/start, held by no other run and
-- bound to that run's one job. Only its sha256 is kept, on the run's row, so the key
-- resolves only while that row is running and inside the stale window: closing the run
-- ends the key, with nothing to revoke.
--
-- Additive: one nullable column and a partial index. Every existing row reads NULL,
-- which is a run with no key, which is what each one is.

ALTER TABLE bench_runs ADD COLUMN run_key_hash TEXT;

CREATE INDEX IF NOT EXISTS bench_runs_key ON bench_runs (run_key_hash) WHERE run_key_hash IS NOT NULL;
