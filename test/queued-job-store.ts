import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The row-backed fake D1 for the claimless transitions (jobs-record, jobs-unclaimed), with
// one rewrite: the transition's summary_sig CASE, which test/fake-sql.ts does not model,
// becomes the branch SQLite takes for a non-null result_summary (every call sends one, and
// the record path refuses a blank one before it writes). Nothing else in the batch is touched.
export function queuedJobStore(
  jobs: Array<Record<string, unknown>>,
  env: Record<string, unknown> = {},
) {
  const d1 = fakeD1({
    namespaces: [
      { namespace: "sample", repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) },
    ],
    jobs,
  });
  const inner = d1.db;
  const db = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: (statements: Array<{ sql: string; params: unknown[] }>) =>
      inner.batch(
        statements.map((s) => ({
          ...s,
          sql: s.sql.replace(
            /summary_sig = CASE WHEN \?3 IS NULL THEN summary_sig ELSE \?8 END/,
            "summary_sig = ?8",
          ),
        })) as unknown as D1PreparedStatement[],
      ),
  } as unknown as D1Database;
  return { d1, env: fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, ...env }) };
}
