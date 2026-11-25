import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { noFlags } from "./agents-schema";
import type { Agent } from "./agents";
import { HOUR_MS } from "./time";
import { toHex } from "@dustinedwards/site-runtime/encoding";

// Only the key's sha256 is stored, on the run's own row (bench_runs.run_key_hash,
// migrations/0050), so the key's life is the row's: no agents row, nothing to revoke.

export const BENCH_STALE_MS = 3 * HOUR_MS;
export const BENCH_NAMESPACE = "bench";

export function newRunKey(): string {
  return `capsid_run_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// The job a run works: the one job in the bench namespace titled as the harness titles it, `bench
// <task_id> <run_id>` (capsid-bench scripts/post-job.mjs). Null unless there is exactly one, so a
// run whose job is missing or doubled can work nothing.
export function runJobTitle(taskId: string, runId: string): string {
  return `bench ${taskId} ${runId}`;
}

export async function runKeyAgent(db: D1Database, hash: string, now: Date): Promise<Agent | null> {
  const row = await db
    .prepare(
      `SELECT id, task_id, run_key_hash FROM bench_runs
       WHERE run_key_hash = ?1 AND arm = 'treatment' AND status = 'running' AND started_at > ?2`,
    )
    .bind(hash, new Date(now.getTime() - BENCH_STALE_MS).toISOString())
    .first<{ id: string; task_id: string; run_key_hash: string }>();
  if (!row || !(await safeEqual(row.run_key_hash, hash))) return null;
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
    scopes: {
      namespaces: [BENCH_NAMESPACE],
      repos: [],
      tools: ["capsid_work_jobs"],
      grants: ["read", "write"],
      flags: noFlags(),
    },
    admin: false,
    row: null,
    benchRun: { run: row.id, job: jobs?.length === 1 ? jobs[0].id : null },
  };
}

// THE REPRODUCTION RECEIPT (the methods paper's protocol, section 2, "Prove it before done"). It
// is kept as one audit row per run, written once, and a run key's complete is accepted only when
// it says the test failed on the base and passed on the diff (src/jobs-seat.ts completeAsCaller).
export const BENCH_REPRO_ACTION = "bench-repro";

export interface ReproReceipt {
  passed: boolean;
  reason: string;
}

export async function readReproReceipt(
  db: D1Database,
  runId: string,
): Promise<ReproReceipt | null> {
  const row = await db
    .prepare(
      "SELECT params FROM audit_log WHERE action = ?1 AND namespace = ?2 AND path = ?3 ORDER BY id LIMIT 1",
    )
    .bind(BENCH_REPRO_ACTION, BENCH_NAMESPACE, runId)
    .first<{ params: string }>();
  if (!row) return null;
  const parsed = JSON.parse(row.params) as Partial<ReproReceipt>;
  return {
    passed: parsed.passed === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}
