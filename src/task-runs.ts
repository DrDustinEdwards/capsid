import type { Env } from "./env";
import type { OpsTask, OpsTaskRun, OpsTaskRunOutcome } from "./ops-types";
import { logEvent } from "./log";

// The run ledger (migrations/0029_task_runs.sql; capsid/decisions.md 2026-09-30,
// "admin panels review adopted", item 1). Every scheduled task goes through runTask,
// which writes one task_runs row per run: start, finish, outcome and a one-line
// reason. The Portal reads the newest runs of each task (readTaskRuns) and flags a
// task that has failed or gone quiet (taskStates).
//
// Adapted from Foxhound's runCronJob (app/lib/cron/run.ts): one wrapper, one row per
// executed run, and the reason column, because "ok" alone cannot tell a sweep that
// found nothing from one that never looked.

export type TaskId =
  | "backup"
  | "improve-open"
  | "skills-refresh"
  | "tick"
  | "lease-sweep"
  | "auto-merge"
  | "skill-cycle"
  | "watcher"
  | "outcome-sweep"
  | "merge-resume"
  | "maintenance"
  | "site-repair";

// Each task, and how long it may go without a run before the Portal says it has
// gone quiet: twice its period, Foxhound's rule (app/lib/cron/alerts.server.ts),
// because one missed run is normal and a flag on it would teach the reader to
// ignore the flag. Null where runs come and go with the work, so a quiet spell
// means nothing: those are flagged only when they fail.
//   tick           */5 * * * *, which carries the five steps below it
//   backup         0 9 * * *
//   improve-open   0 8,9 * * *, running at 03:00 America/Chicago only
//   skills-refresh 30 9 * * *, doing its work on one UTC day a week
//   watcher        on the tick, every cadence_min minutes (src/watcher.ts); its
//                  period is read from the watcher's own snapshot
export const TASKS: ReadonlyArray<{ id: TaskId; label: string; period_ms: number | null }> = [
  { id: "tick", label: "Five-minute tick", period_ms: 5 * 60_000 },
  { id: "watcher", label: "Watcher pass", period_ms: null },
  { id: "backup", label: "Backup", period_ms: 24 * 3_600_000 },
  { id: "improve-open", label: "Improve opener", period_ms: 24 * 3_600_000 },
  { id: "skills-refresh", label: "Skills refresh", period_ms: 7 * 24 * 3_600_000 },
  { id: "auto-merge", label: "Auto-merge step", period_ms: null },
  { id: "lease-sweep", label: "Job lease sweep", period_ms: null },
  { id: "skill-cycle", label: "Skill evaluation cycle", period_ms: null },
  { id: "outcome-sweep", label: "Merge-state sweep", period_ms: null },
  { id: "merge-resume", label: "Stale-job merge resume", period_ms: null },
  { id: "maintenance", label: "Daily maintenance pass", period_ms: 24 * 3_600_000 },
  // One row per call to a site's operator API (src/site-repair.ts), from the watcher or a
  // person, so its runs come and go with the drift.
  { id: "site-repair", label: "Site repairs", period_ms: null },
];

const STALE_PERIODS = 2;
// Rows older than this are pruned, PRUNE_BATCH at a time on each write.
export const RUN_RETENTION_DAYS = 14;
const PRUNE_BATCH = 50;
// How many of each task's newest runs the Portal shows.
export const RUNS_PER_TASK = 5;
// A reason is one line: what the run did or why it did not.
export const REASON_MAX = 300;

/** What a task's body reports about the run it made. Null means it was not due and
 *  made no run (the watcher between passes, the sweep before its day), so nothing is
 *  recorded. */
export type TaskResult = { outcome: Exclude<OpsTaskRunOutcome, "threw">; reason: string } | null;

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/** The insert and a bounded prune, in one batch. */
export function taskRunStatements(db: D1Database, task: TaskId, started: Date, finished: Date, outcome: OpsTaskRunOutcome, reason: string): D1PreparedStatement[] {
  const cutoff = new Date(finished.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString();
  return [
    db
      .prepare(`INSERT INTO task_runs (task, started_at, finished_at, outcome, reason) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(task, started.toISOString(), finished.toISOString(), outcome, oneLine(reason)),
    // The oldest PRUNE_BATCH rows by id, of which those past retention go: rows are
    // appended in time order, so this stays a short index walk however large the
    // table is (the same prune as session_events, src/ops-hooks.ts).
    db
      .prepare(`DELETE FROM task_runs WHERE id IN (SELECT id FROM task_runs ORDER BY id LIMIT ?1) AND finished_at < ?2`)
      .bind(PRUNE_BATCH, cutoff),
  ];
}

/** Write one run. Never throws, so a failed ledger write cannot stop the task it
 *  records or the tasks after it. A write that fails is said in the log, by task, and
 *  the Portal then shows that task as quiet: the ledger's own failure is visible. */
async function record(env: Env, task: TaskId, started: Date, outcome: OpsTaskRunOutcome, reason: string): Promise<void> {
  try {
    await env.DB.batch(taskRunStatements(env.DB, task, started, new Date(), outcome, reason));
  } catch (err) {
    logEvent("error", "TASK_RUN_UNRECORDED", { message: `TASK_RUN_UNRECORDED ${task} ${outcome}: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/**
 * Run one scheduled task and record it. A body that throws is recorded as `threw`
 * with the error, logged with `tag`, and then rethrown when `rethrow` is set (a cron
 * branch, so the invocation shows as failed) or swallowed into the record otherwise
 * (a tick step, so one step's throw does not stop the steps after it; the record and
 * the log line are where it is said).
 */
export async function runTask<T>(
  env: Env,
  task: TaskId,
  body: () => Promise<T>,
  judge: (value: T) => TaskResult,
  opts: { tag: string; rethrow: boolean }
): Promise<T | null> {
  const started = new Date();
  let value: T;
  try {
    value = await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("error", opts.tag, {
      message: `${opts.tag} ${err instanceof Error && err.stack ? `${message}\n${err.stack}` : message}`,
    });
    await record(env, task, started, "threw", message);
    if (opts.rethrow) throw err;
    return null;
  }
  const result = judge(value);
  if (result) await record(env, task, started, result.outcome, result.reason);
  return value;
}

interface TaskRunRow {
  task: string;
  started_at: string;
  finished_at: string;
  outcome: OpsTaskRunOutcome;
  reason: string;
}

/** Each task's newest runs: one keyed read per task, through task_runs_task, in one
 *  batch. TASKS.length statements, counted in OPS_FEED_READS (src/ops-feed.ts). */
export async function readTaskRuns(db: D1Database): Promise<Map<TaskId, OpsTaskRun[]>> {
  const results = await db.batch<TaskRunRow>(
    TASKS.map((t) =>
      db
        .prepare(`SELECT task, started_at, finished_at, outcome, reason FROM task_runs WHERE task = ?1 ORDER BY id DESC LIMIT ?2`)
        .bind(t.id, RUNS_PER_TASK)
    )
  );
  const out = new Map<TaskId, OpsTaskRun[]>();
  TASKS.forEach((t, i) => {
    out.set(
      t.id,
      (results[i]?.results ?? []).map((r) => ({ started_at: r.started_at, finished_at: r.finished_at, outcome: r.outcome, reason: r.reason }))
    );
  });
  return out;
}

/** Each task with its newest runs and its flag, decided at `now`.
 *  - `failing`: the newest run threw or was refused.
 *  - `quiet`: a periodic task whose newest run is more than STALE_PERIODS periods old.
 *  - `never`: no run in the ledger. A notice, not a fault: after the migration every
 *    task starts here, and the daily ones stay here until their hour. */
export function taskStates(runs: Map<TaskId, OpsTaskRun[]>, now: Date, watcherCadenceMin: number): OpsTask[] {
  return TASKS.map((t) => {
    const recent = runs.get(t.id) ?? [];
    const last = recent[0] ?? null;
    const period = t.id === "watcher" ? watcherCadenceMin * 60_000 : t.period_ms;
    let flag: OpsTask["flag"] = null;
    if (last === null) flag = "never";
    else if (last.outcome === "threw" || last.outcome === "refused") flag = "failing";
    else if (period !== null && now.getTime() - Date.parse(last.finished_at) > STALE_PERIODS * period) flag = "quiet";
    return { id: t.id, label: t.label, period_ms: period, flag, recent };
  });
}
