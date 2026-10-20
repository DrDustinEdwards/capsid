import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { noFlags } from "./agents-schema";
import type { Agent } from "./agents";
import { bytesToHex } from "./encoding";

// THE RUN KEY (the methods paper's protocol, section 4, "The run key"; decided
// 2026-10-19). Each treatment run gets its own Capsid key, minted by /bench/start for
// that run id and held by no other run. The harness posts the run's one job with its
// own driver key, which the agent never holds. The run key's only successful calls are
// claim, and list by id, of that one job (src/scope.ts benchRunRefusal). It stops
// working when the run closes, or once the run is past the stale window.
//
// Only the key's sha256 is stored, on the run's own row (bench_runs.run_key_hash,
// migrations/0050), so the key's life is the row's: no agents row, nothing to revoke.

// A running row older than this no longer holds a slot (src/bench.ts), and its key no
// longer resolves.
export const BENCH_STALE_MS = 3 * 60 * 60 * 1000;
export const BENCH_NAMESPACE = "bench";

export function newRunKey(): string {
  return `capsid_run_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// The job a run works: the one job in the bench namespace titled as the harness titles
// it, `bench <task_id> <run_id>` (capsid-bench scripts/post-job.mjs). Null unless there
// is exactly one, so a run whose job is missing or doubled can work nothing.
export function runJobTitle(taskId: string, runId: string): string {
  return `bench ${taskId} ${runId}`;
}

/** The caller a run key resolves to, or null when no running treatment run holds it. */
export async function runKeyAgent(db: D1Database, hash: string, now: Date): Promise<Agent | null> {
  const row = await db
    .prepare(
      `SELECT id, task_id, run_key_hash FROM bench_runs
       WHERE run_key_hash = ?1 AND arm = 'treatment' AND status = 'running' AND started_at > ?2`
    )
    .bind(hash, new Date(now.getTime() - BENCH_STALE_MS).toISOString())
    .first<{ id: string; task_id: string; run_key_hash: string }>();
  if (!row || !await safeEqual(row.run_key_hash, hash)) return null;
  const { results: jobs } = await db
    .prepare("SELECT id FROM jobs WHERE namespace = ?1 AND title = ?2 LIMIT 2")
    .bind(BENCH_NAMESPACE, runJobTitle(row.task_id, row.id))
    .all<{ id: string }>();
  const actor = `agent:bench-run-${row.id}`;
  return {
    id: actor,
    name: `bench-run-${row.id}`,
    kind: "driver",
    actor,
    scopes: { namespaces: [BENCH_NAMESPACE], repos: [], tools: ["capsid_work_jobs"], grants: ["read", "write"], flags: noFlags() },
    admin: false,
    row: null,
    benchRun: { run: row.id, job: jobs?.length === 1 ? jobs[0].id : null },
  };
}
