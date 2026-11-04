import { env } from "cloudflare:test";
import { resetDb } from "@dustinedwards/devkit/d1";

// Every table cleared between cases (devkit ./d1 resetDb reads them from the schema, so a
// migration's new table is cleared too), except the ones that cannot or must not be:
// the append-only and frozen tables, whose triggers refuse a DELETE once they hold a row
// (migrations 0023, 0031, 0047, 0049), and the rows the migrations seed (ops_sites,
// shared_packages), which the code under test reads.
const KEEP = [
  "job_claims",
  "job_evaluations",
  "job_touches",
  "bench_tasks",
  "bench_runs",
  "bench_registration",
  "bench_draw",
  "ops_sites",
  "shared_packages",
];

export async function resetCapsidDb(): Promise<void> {
  await resetDb(env.DB, { keep: KEEP });
}
