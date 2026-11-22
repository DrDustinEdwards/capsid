import { BENCH_STALE_MS } from "./bench-run-key";
import type { Arm } from "./bench-requests";

// The design's k=3 repeats (D17): each model arm gets this many slots per task. A slot may
// be started twice, the second only when the first came back unjudged (a machine failure); a
// scored or running attempt holds its slot. Enforced here, not in the hand-dispatched
// workflow. A running row past BENCH_STALE_MS counts as unjudged.
export const BENCH_REPEATS = 3;
export const MODEL_ARMS: readonly Arm[] = ["baseline", "treatment"];

//
// THE ORDER (section 5, "Order"). A drawn task's six slots run in the
// fixed order baseline, treatment, baseline, treatment, baseline, treatment, each ended
// before the next starts, and a drawn task's first slot starts only when every task
// before it on the draw has ended all six.
const BENCH_OUTAGE_MIN_ENDED = 4;
export interface PriorRun {
  status: string;
  started_at: string;
  finished_at?: string | null;
  stopped_on_error?: number | boolean | null;
}

/** Whether a UTC hour with this many ended model runs, this many of them stopped on an error, is an outage hour. */
export function isOutageHour(ended: number, errors: number): boolean {
  return ended >= BENCH_OUTAGE_MIN_ENDED && errors * 2 >= ended;
}

// The outage hours as of `at`, from the runs that had ended by then, as the first 13
// characters of an ISO time ("2026-10-19T02").
export async function outageHours(db: D1Database, at: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT substr(finished_at, 1, 13) AS hour, COUNT(*) AS ended,
         SUM(CASE WHEN json_extract(report, '$.stopped_on_error') = 1 THEN 1 ELSE 0 END) AS errors
       FROM bench_runs WHERE arm IN ('baseline', 'treatment') AND finished_at IS NOT NULL AND finished_at <= ?1 GROUP BY hour`,
    )
    .bind(at)
    .all<{ hour: string; ended: number; errors: number }>();
  return new Set(results.filter((h) => isOutageHour(h.ended, h.errors)).map((h) => h.hour));
}

/** The runs that count toward slots: an error stop in an outage hour is no attempt at all. */
export function countedRuns<T extends PriorRun>(
  runs: readonly T[],
  outage: ReadonlySet<string>,
): T[] {
  return runs.filter(
    (r) => !(r.stopped_on_error && r.finished_at && outage.has(r.finished_at.slice(0, 13))),
  );
}

export async function priorRuns(
  db: D1Database,
  taskId: string,
  arm: string,
): Promise<(PriorRun & { id: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, started_at, finished_at, json_extract(report, '$.stopped_on_error') AS stopped_on_error
       FROM bench_runs WHERE task_id = ?1 AND arm = ?2 ORDER BY started_at, rowid`,
    )
    .bind(taskId, arm)
    .all<PriorRun & { id: string }>();
  return results;
}

// Which slot and attempt the next start of a model arm on a task takes, from that task
// and arm's earlier runs in start order, or null when every slot is used. Slots fill in
// order, so a slot is identified by position: an unjudged first attempt leaves its slot
// waiting for its one rerun, and the next start fills that slot before opening another.
export function nextSlot(
  runs: readonly PriorRun[],
  staleBefore: string,
  repeats = BENCH_REPEATS,
): { slot: number; attempt: 1 | 2 } | null {
  let slot = 0;
  let waiting = false;
  for (const run of runs) {
    const unjudged =
      run.status === "unjudged" || (run.status === "running" && run.started_at <= staleBefore);
    if (waiting) {
      waiting = false;
      continue;
    }
    slot++;
    waiting = unjudged;
  }
  if (waiting) return { slot, attempt: 2 };
  return slot < repeats ? { slot: slot + 1, attempt: 1 } : null;
}

/** The slot and attempt a model start at `at` takes, from the task and arm's runs started
 *  before it, each read as it stood at `at`: a run that ended later reads as running. Pure. */
export function slotAt(
  runs: readonly PriorRun[],
  outage: ReadonlySet<string>,
  at: string,
): { slot: number; attempt: 1 | 2 } | null {
  const stood = runs.map((r) =>
    r.finished_at && r.finished_at <= at
      ? r
      : { ...r, status: "running", finished_at: null, stopped_on_error: null },
  );
  return nextSlot(
    countedRuns(stood, outage),
    new Date(Date.parse(at) - BENCH_STALE_MS).toISOString(),
  );
}

/** How many of a task and arm's slots have ended: scored, or unjudged on both attempts.
 *  A running attempt, or an unjudged one still owed its rerun, has not. Pure. */
export function slotsDone(runs: readonly PriorRun[], staleBefore: string): number {
  let done = 0;
  let waiting = false;
  for (const run of runs) {
    const stale = run.status === "running" && run.started_at <= staleBefore;
    const running = run.status === "running" && !stale;
    if (waiting) {
      waiting = false;
      if (!running) done++;
      continue;
    }
    if (run.status === "unjudged" || stale) waiting = true;
    else if (!running) done++;
  }
  return done;
}

/** Why a model start on a drawn task is out of order, or null. `slot` is the slot the
 *  start takes; `done` counts each arm's ended slots on this task; `earlierOpen` is the
 *  first earlier drawn task that has not ended all six, if any. Pure. */
export function orderRefusal(
  arm: Arm,
  slot: number,
  done: Record<"baseline" | "treatment", number>,
  running: Record<"baseline" | "treatment", boolean>,
  earlierOpen: string | null,
): string | null {
  if (arm === "baseline" && slot === 1 && earlierOpen)
    return `the draw runs in order: ${earlierOpen} has not ended its six slots`;
  const before =
    arm === "baseline"
      ? { arm: "treatment" as const, need: slot - 1 }
      : { arm: "baseline" as const, need: slot };
  if (running[before.arm] || done[before.arm] !== before.need) {
    return `the slots run baseline, treatment, baseline, treatment, baseline, treatment: ${arm} slot ${slot} starts when ${before.arm} has ended ${before.need} and none is running (it has ended ${done[before.arm]})`;
  }
  return null;
}

// The order rule's facts for a start, read from the database. Tasks off the draw (the
// pilot) have no order.
export async function orderOf(
  db: D1Database,
  taskId: string,
  arm: Arm,
  slot: number,
  outage: ReadonlySet<string>,
  stale: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT position FROM bench_draw WHERE task_id = ?1")
    .bind(taskId)
    .first<{ position: number }>();
  if (!row) return null;
  const state = async (id: string) => {
    const done = { baseline: 0, treatment: 0 };
    const running = { baseline: false, treatment: false };
    for (const a of MODEL_ARMS) {
      const runs = countedRuns(await priorRuns(db, id, a), outage);
      done[a as "baseline" | "treatment"] = slotsDone(runs, stale);
      running[a as "baseline" | "treatment"] = runs.some(
        (r) => r.status === "running" && r.started_at > stale,
      );
    }
    return { done, running };
  };
  let earlierOpen: string | null = null;
  if (arm === "baseline" && slot === 1) {
    const { results: earlier } = await db
      .prepare("SELECT task_id FROM bench_draw WHERE position < ?1 ORDER BY position")
      .bind(row.position)
      .all<{ task_id: string }>();
    for (const { task_id: id } of earlier) {
      const s = await state(id);
      if (s.done.baseline < BENCH_REPEATS || s.done.treatment < BENCH_REPEATS) {
        earlierOpen = id;
        break;
      }
    }
  }
  const own = await state(taskId);
  return orderRefusal(arm, slot, own.done, own.running, earlierOpen);
}
