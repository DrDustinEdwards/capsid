import type { Env } from "./env";
import type { OpsTask, OpsTaskRun, OpsTaskRunOutcome } from "./ops-types/feed";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { withTimeout } from "@dustinedwards/site-runtime/time";
import { MINUTE_MS, HOUR_MS, DAY_MS } from "./time";

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

// Twice its period, Foxhound's rule: one missed run is normal, and flagging it would teach the
// reader to ignore the flag.
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
  { id: "park-due", label: "Parked jobs coming back", period_ms: null },
  { id: "maintenance", label: "Daily maintenance pass", period_ms: DAY_MS },
  { id: "site-repair", label: "Site repairs", period_ms: null },
  { id: "site-backup", label: "Site backups", period_ms: null },
  { id: "site-job", label: "Site jobs run now", period_ms: null },
  { id: "public-build", label: "Public model build", period_ms: DAY_MS },
  { id: "system-facts", label: "Versions and secrets build", period_ms: DAY_MS },
  { id: "push", label: "Phone alerts", period_ms: null },
  // Off until Email Routing is on, so a quiet spell means nothing and only a refusal is flagged.
  { id: "digest", label: "Daily email digest", period_ms: null },
  { id: "merge-units", label: "Merge unit proposals", period_ms: null },
  { id: "merge-safety", label: "Auto-merge safety meter", period_ms: null },
  { id: "offaccount-dispatch", label: "Amazon copy start", period_ms: null },
  { id: "doc-index", label: "Search index", period_ms: null },
  { id: "supersede", label: "Supersede pass", period_ms: null },
  { id: "site-pulse", label: "Site pulse", period_ms: null },
  { id: "signed-in-crawl", label: "Signed-in header crawl", period_ms: 2 * HOUR_MS },
  { id: "tool-call-log-export", label: "Tool-call log export", period_ms: DAY_MS },
];

const STALE_PERIODS = 2;
// Such a task records a run only when it acts, so no later "ok" row may clear a failure.
const EVENT_FAILURE_WINDOW_MS = DAY_MS;
export const RUN_RETENTION_DAYS = 14;
const PRUNE_BATCH = 50;
export const RUNS_PER_TASK = 5;
export const REASON_MAX = 300;

// Null means it was not due and made no run, so nothing is recorded.
export type TaskResult = { outcome: Exclude<OpsTaskRunOutcome, "threw">; reason: string } | null;

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

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
    // Rows are appended in time order, so this stays a short index walk.
    db
      .prepare(
        `DELETE FROM task_runs WHERE id IN (SELECT id FROM task_runs ORDER BY id LIMIT ?1) AND finished_at < ?2`,
      )
      .bind(PRUNE_BATCH, cutoff),
  ];
}

// Never throws, so a failed ledger write cannot stop the task or those after it; the Portal then
// shows the task as quiet.
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

// `failing`: the newest run threw or was refused; for a task without a period, only while that run
// is inside EVENT_FAILURE_WINDOW_MS.
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
