import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { extractStatements } from "./scripts/sql-statements.mjs";

// THE INTEGRATION LAYER (audit 2026-09-07). node:test under test/ drives handlers
// against fakes; this runs the whole Worker inside workerd with a real D1, real KV
// and real R2. Both suites run in CI and neither replaces the other.
//
// WHAT THE FAKES CANNOT REACH, and why this exists. test/fakes.ts answers SQL from
// rows in memory, which proves which statements a handler issues and nothing about
// whether SQLite accepts them. Every FTS5 trigger, every ON CONFLICT, every
// RETURNING, the whole OAuth provider (a library this repo does not own, wired into
// the entry module) and the scheduled handler's cron dispatch were untestable
// before this file. The 2026-08-09 consent outage lived in exactly that gap for 26
// days.
//
// BINDINGS ARE DECLARED HERE, not read from wrangler.jsonc, and that is deliberate.
// The real wrangler.jsonc is gitignored (capsid/conventions.md, public-repo
// hygiene), so a fresh clone and CI have none. Pointing the pool at a config file
// that does not exist would make this suite unrunnable in the one place it matters
// most.
//
// THE COMPATIBILITY DATE HERE IS NOT THE DEPLOY DATE, and that is a limitation
// rather than a choice. The workerd binary this pool ships supports dates up to
// 2026-08-22; production runs 2026-09-06 (scripts/bindings.mjs, asserted by
// test/cloudflare-platform.test.ts). Setting the deploy date here fails at
// startup with "the newest date supported by this server binary is 2026-08-22",
// so the suite runs at the newest date its runtime HAS.
// test/integration-layer.test.ts asserts the direction of the gap: the
// integration date must be no later than the deploy date, and the day the pool
// catches up the two are expected to converge. Anything a compatibility date
// between the two changes is outside what this layer can see.
export const INTEGRATION_COMPAT_DATE = "2026-08-22";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// Every SQL statement in src/, walked from the source at config time. A setup file
// runs inside workerd and cannot read the filesystem, so the walk happens here and
// arrives as a binding. test-integration/query-plans.test.ts runs EXPLAIN QUERY
// PLAN over the reads.
const sql = extractStatements(path.join(import.meta.dirname, "src"));

// Every src/ file that calls `.prepare(`, listed by fs's own recursive walk rather
// than the extractor's, so query-plans.test.ts can check that the extractor saw each
// one. That replaced a fixed floor on the statement count: the floor did catch the
// extractor missing every subdirectory once, and it also went red whenever a refactor
// moved statements around.
const srcDir = path.join(import.meta.dirname, "src");
const prepareFiles = readdirSync(srcDir, { recursive: true })
  .map((f) => String(f).split(path.sep).join("/"))
  .filter((f) => f.endsWith(".ts") && readFileSync(path.join(srcDir, f), "utf8").includes(".prepare("));

// Two legacy operator keys, obviously fake, and the OPERATOR_KEY_HASH line that admits
// them: the plain hash is the write (admin) key, the "ro:" one the read key. The keys
// reach the test file as a binding so test-integration/route-gates.test.ts can present
// them to /ops/backup exactly as a caller would.
const TEST_OPERATOR_KEYS = { write: "integration-legacy-write-key", read: "integration-legacy-read-key" };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: INTEGRATION_COMPAT_DATE,
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        d1Databases: ["DB"],
        kvNamespaces: ["APP_KV", "OAUTH_KV"],
        r2Buckets: ["MEDIA", "HOLDOUT"],
        bindings: {
          // The migrations, handed to the setup file through the env. This is the
          // pool's route for it: a setup file runs inside workerd and cannot read
          // the filesystem.
          TEST_MIGRATIONS: migrations,
          TEST_SQL_STATEMENTS: sql.statements,
          TEST_SQL_SKIPPED: sql.skipped,
          TEST_SQL_PREPARE_FILES: prepareFiles,
          TEST_OPERATOR_KEYS,
          OPERATOR_KEY_HASH: `${sha256(TEST_OPERATOR_KEYS.write)},ro:${sha256(TEST_OPERATOR_KEYS.read)}`,
          // Non-secret vars, matching wrangler.jsonc.example.
          GITHUB_APP_CLIENT_ID: "test-client-id",
          // Secrets, with obviously fake values. capsid/conventions.md hard rule:
          // no real content in any fixture. The HMAC tests derive their keys from
          // this root exactly as the Worker does, so a signature that verifies here
          // verifies for the right reason rather than because both sides are stubs.
          IMPROVE_SCORE_SECRET: "integration-root-secret-not-a-real-one",
          ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
          GITHUB_CLIENT_ID: "test-oauth-client-id",
          GITHUB_CLIENT_SECRET: "test-oauth-client-secret",
          BUILD_SHA: "integration",
        },
      },
    }),
  ],
  test: {
    include: ["test-integration/**/*.test.ts"],
    setupFiles: ["./test-integration/apply-migrations.ts"],
    // THE DEFAULT 5s IS TOO TIGHT FOR WHAT THESE ACTUALLY DO, and finding that
    // out from a flake is worse than saying it here. One test applies every
    // migration and dumps every table to R2; another runs EXPLAIN QUERY PLAN over
    // 62 statements. Measured 8 to 12 seconds each on a loaded machine, under 5
    // when idle, which is exactly the band that goes red in CI and green locally.
    // The timeout is a guard against a hang, not a performance budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
