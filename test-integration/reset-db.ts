import { env } from "cloudflare:test";
import { resetDb } from "@dustinedwards/devkit/d1";

// Every table is cleared between cases except the rows migrations seed (ops_sites, shared_packages), which the code under
// test reads.
const KEEP = ["ops_sites", "shared_packages"];

export async function resetCapsidDb(): Promise<void> {
  await resetDb(env.DB, { keep: KEEP });
}
