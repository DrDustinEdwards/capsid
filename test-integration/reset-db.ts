import { env } from "cloudflare:test";
import { resetDb } from "@dustinedwards/devkit/d1";

// Every table is cleared between cases except the append-only and frozen ones, whose triggers refuse DELETE once they hold
// a row, and the rows migrations seed (ops_sites, shared_packages), which the code under test reads.
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
