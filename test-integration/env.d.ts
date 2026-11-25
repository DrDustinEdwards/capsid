// `cloudflare:test` types `env` as the global Cloudflare.Env; declared here from the Worker's Env, so a binding
// missing from vitest.config.ts is a typecheck failure, not a runtime `undefined`.
import type { Env as WorkerEnv } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Handed to the setup file through a binding: a setup file runs inside
      // workerd and cannot read migrations/ off the filesystem itself.
      TEST_MIGRATIONS: D1Migration[];
      // Every SQL statement in src/, walked at config time (scripts/sql-statements.ts).
      TEST_SQL_STATEMENTS: { file: string; sql: string }[];
      TEST_SQL_SKIPPED: { file: string; sql: string }[];
      // Every src/ file containing `.prepare(`, from a separate fs walk.
      TEST_SQL_PREPARE_FILES: string[];
    }
  }
}

export {};
