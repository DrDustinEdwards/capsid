import type { Env } from "./env";
import type { OpsTask, OpsTaskRun, OpsTaskRunOutcome } from "./ops-types/feed";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { withTimeout } from "@dustinedwards/site-runtime/time";
import { MINUTE_MS, HOUR_MS, DAY_MS } from "./time";

// The run ledger (migrations/0029_task_runs.sql). Every scheduled task goes through runTask, which
// writes one task_runs row per run: start, finish, outcome and a one-line reason. The Portal reads
// the newest runs of each task (readTaskRuns) and flags a task that has failed or gone quiet
// (taskStates).

export type TaskId =
  | "backup"
  | "tick"
  | "auto-merge"
  | "watcher"
  | "outcome-sweep"
  | "merge-resume"
  | "park-due"
  | "maintenance"
  | "site-repair"
  | "site-backup"
  | "site-job"
  | "public-build"
  | "system-facts"
  | "push"
  | "digest"
  | "merge-units"
  | "merge-safety"
  | "offaccount-dispatch"
  | "doc-index"
  | "supersede"
  | "site-pulse"
  | "signed-in-crawl"
  | "tool-call-log-export";

// Each task, and how long it may go without a run before the Portal says it has gone quiet: twice
// its period, Foxhound's rule (app/lib/cron/alerts.server.ts), because one missed run is normal and
// a flag on it would teach the reader to ignore the flag.
export const TASKS: ReadonlyArray<{
  id: TaskId;
  label: string;
  period_ms: number | null;
  timeout_ms?: number;
}> = [
  { id: "tick", label: "Five-minute tick", period_ms: 5 * MINUTE_MS, timeout_ms: 4 * MINUTE_MS },
  { id: "watcher", label: "Watcher pass", period_ms: null },
  { id: "backup", label: "Backup", period_ms: DAY_MS, timeout_ms: 14 * MINUTE_MS },
  { id: "auto-merge", label: "Auto-merge step", period_ms: null },
  { id: "outcome-sweep", label: "Merge-state sweep", period_ms: null },
  { id: "merge-resume", label: "Stale-job merge resume", period_ms: null },
  // Parked jobs whose due date passed, back to the queue (src/jobs-park.ts), on the tick;
  // recorded only when one was due.
  { id: "park-due", label: "Parked jobs coming back", period_ms: null },
  { id: "maintenance", label: "Daily maintenance pass", period_ms: DAY_MS },
  // One row per call to a site's operator API (src/site-repair.ts), from the watcher or a
  // person, so its runs come and go with the drift.
  { id: "site-repair", label: "Site repairs", period_ms: null },
  // One row per back up now call from Capsid Admin's backups (src/site-backup.ts), on
  // demand only: each site's own nightly cron does the backing up.
  { id: "site-backup", label: "Site backups", period_ms: null },
  // One row per run_job call from Capsid Admin's run_job control (src/site-jobs.ts), on
  // demand only: each site's own cron runs its jobs on schedule.
  { id: "site-job", label: "Site jobs run now", period_ms: null },
  // The public system model (src/public-data.ts), built once a UTC day on the tick.
  { id: "public-build", label: "Public model build", period_ms: DAY_MS },
  // The versions and secrets models (src/system-facts.ts), built once a UTC day on the tick.
  { id: "system-facts", label: "Versions and secrets build", period_ms: DAY_MS },
  // Phone alerts (src/push.ts), on the tick; recorded only when an alert was due.
  { id: "push", label: "Phone alerts", period_ms: null },
  // The daily email digest (src/digest.ts), on the tick; off until Email Routing is on,
  // so a quiet spell means nothing by itself and only a refusal is flagged.
  { id: "digest", label: "Daily email digest", period_ms: null },
  // Merge unit promotion and demotion (src/merge-units.ts), on the tick; recorded only
  // when its report or a suspension changed.
  { id: "merge-units", label: "Merge unit proposals", period_ms: null },
  // The auto-merge safety meter and shutoff (src/merge-safety.ts), on the tick; recorded
  // only when a revert was recorded, a namespace paused or the meter changed.
  { id: "merge-safety", label: "Auto-merge safety meter", period_ms: null },
  // The nightly Amazon copy's start (src/offaccount-dispatch.ts), on the tick; recorded only
  // on the day it dispatched, found the run already there, or was refused.
  { id: "offaccount-dispatch", label: "Amazon copy start", period_ms: null },
  // The meaning index (src/doc-index.ts), on the tick; recorded only when it started a
  // sync or was refused, so a quiet spell means nothing changed.
  { id: "doc-index", label: "Search index", period_ms: null },
  // The daily supersede pass (src/supersede.ts), with the backup; recorded only when it
  // marked something.
  { id: "supersede", label: "Supersede pass", period_ms: null },
  // The five-minute site pulse (src/site-pulse.ts), on the tick; recorded only when a site
  // was called down or came back.
  { id: "site-pulse", label: "Site pulse", period_ms: null },
  // The signed-in crawl of the Portal (src/signed-in-crawl.ts), hourly on the tick.
  { id: "signed-in-crawl", label: "Signed-in header crawl", period_ms: 2 * HOUR_MS },
  // The daily copy of the tool-call log to AUDIT_BUCKET (site-runtime exportAuditLog; area
  // 11, L6-L7), with the backup.
  { id: "tool-call-log-export", label: "Tool-call log export", period_ms: DAY_MS },
];

const STALE_PERIODS = 2;
// How long the newest failure of a task without a period counts as current. Such a task records a
// run only when it acts, so no later "ok" row may ever come to clear a failure: doc-index stays
// silent while nothing changes, site-repair while no site drifts.
const EVENT_FAILURE_WINDOW_MS = DAY_MS;
// Rows older than this are pruned, PRUNE_BATCH at a time on each write.
export const RUN_RETENTION_DAYS = 14;
const PRUNE_BATCH = 50;
// How many of each task's newest runs the Portal shows.
export const RUNS_PER_TASK = 5;
// A reason is one line: what the run did or why it did not.
export const REASON_MAX = 300;

// What a task's body reports about the run it made. Null means it was not due and made no run (the
// watcher between passes, the sweep before its day), so nothing is recorded.
export type TaskResult = { outcome: Exclude<OpsTaskRunOutcome, "threw">; reason: string } | null;

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/** The insert and a bounded prune, in one batch. */
export function taskRunStatements(
  db: D1Database,
  task: TaskId,
  started: Date,
  finished: Date,
  outcome: OpsTaskRunOutcome,
  reason: string,
): D1PreparedStatement[] {
  const cutoff = new Date(finished.getTime() - RUN_RETENTION_DAYS * DAY_MS).toISOString();
  return [
    db
      .prepare(
        `INSERT INTO task_runs (task, started_at, finished_at, outcome, reason) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(task, started.toISOString(), finished.toISOString(), outcome, oneLine(reason)),
    // The oldest PRUNE_BATCH rows by id, of which those past retention go: rows are
    // appended in time order, so this stays a short index walk however large the
    // table is.
    db
      .prepare(
        `DELETE FROM task_runs WHERE id IN (SELECT id FROM task_runs ORDER BY id LIMIT ?1) AND finished_at < ?2`,
      )
      .bind(PRUNE_BATCH, cutoff),
  ];
}

// Write one run. Never throws, so a failed ledger write cannot stop the task it records or the
// tasks after it. A write that fails is said in the log, by task, and the Portal then shows that
// task as quiet: the ledger's own failure is visible.
async function record(
  env: Env,
  task: TaskId,
  started: Date,
  outcome: OpsTaskRunOutcome,
  reason: string,
): Promise<void> {
  try {
    await env.DB.batch(taskRunStatements(env.DB, task, started, new Date(), outcome, reason));
  } catch (err) {
    logEvent(
      "TASK_RUN_UNRECORDED",
      {
        message: `TASK_RUN_UNRECORDED ${task} ${outcome}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
}

/** Run one scheduled task and record it. */
export async function runTask<T>(
  env: Env,
  task: TaskId,
  body: () => Promise<T>,
  judge: (value: T) => TaskResult,
  opts: { tag: string; rethrow: boolean },
): Promise<T | null> {
  const started = new Date();
  const timeoutMs = TASKS.find((t) => t.id === task)?.timeout_ms;
  let value: T;
  try {
    value = timeoutMs === undefined ? await body() : await withTimeout(body(), timeoutMs);
  } catch (err) {
    const message = errorMessage(err);
    logEvent(
      opts.tag,
      {
        message: `${opts.tag} ${err instanceof Error && err.stack ? `${message}\n${err.stack}` : message}`,
      },
      { level: "error" },
    );
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

// Each task's newest runs: one keyed read per task, through task_runs_task, in one batch.
// TASKS.length statements, counted in OPS_FEED_READS (src/ops-feed.ts).
export async function readTaskRuns(db: D1Database): Promise<Map<TaskId, OpsTaskRun[]>> {
  const results = await db.batch<TaskRunRow>(
    TASKS.map((t) =>
      db
        .prepare(
          `SELECT task, started_at, finished_at, outcome, reason FROM task_runs WHERE task = ?1 ORDER BY id DESC LIMIT ?2`,
        )
        .bind(t.id, RUNS_PER_TASK),
    ),
  );
  const out = new Map<TaskId, OpsTaskRun[]>();
  TASKS.forEach((t, i) => {
    out.set(
      t.id,
      (results[i]?.results ?? []).map((r) => ({
        started_at: r.started_at,
        finished_at: r.finished_at,
        outcome: r.outcome,
        reason: r.reason,
      })),
    );
  });
  return out;
}

// Each task with its newest runs and its flag, decided at `now`. - `failing`: the newest run threw
// or was refused; for a task without a period, only while that run is inside
// EVENT_FAILURE_WINDOW_MS.
export function taskStates(
  runs: Map<TaskId, OpsTaskRun[]>,
  now: Date,
  watcherCadenceMin: number,
): OpsTask[] {
  return TASKS.map((t) => {
    const recent = runs.get(t.id) ?? [];
    const last = recent[0] ?? null;
    const period = t.id === "watcher" ? watcherCadenceMin * MINUTE_MS : t.period_ms;
    let flag: OpsTask["flag"] = null;
    if (last === null) flag = "never";
    else if (last.outcome === "threw" || last.outcome === "refused") {
      if (
        t.period_ms !== null ||
        now.getTime() - Date.parse(last.finished_at) <= EVENT_FAILURE_WINDOW_MS
      )
        flag = "failing";
    } else if (
      period !== null &&
      now.getTime() - Date.parse(last.finished_at) > STALE_PERIODS * period
    )
      flag = "quiet";
    return { id: t.id, label: t.label, period_ms: period, flag, recent };
  });
}
