import { bytesToHex } from "./encoding";
import type { Env } from "./env";
import { claimJti, MAX_REPORT_BYTES, readBoundedText, verifyBenchRequest } from "./signed-requests";
import { breakerRefusal, breakerState } from "./job-breaker";
import { logEvent } from "./log";
import { BENCH_NAMESPACE, BENCH_REPRO_ACTION, BENCH_STALE_MS, newRunKey, readReproReceipt, runJobTitle } from "./bench-run-key";
import { sha256Hex } from "./auth";
import type { Agent } from "./agents";
import { noFlags } from "./agents-schema";
import { adminFailJob, supersedeJob, workRecorded } from "./jobs-seat";
import { readJob } from "./jobs-transition";
import { auditStatement, isMissingRowAbort, requireBenchRunRunning } from "./store-guards";
import { textResponse } from "./http";
import { type Arm, type Refusal, JTI_SCOPE, parseTaskRequest, parseDrawRequest, type BenchRegistration, parseStartRequest, parseReproRequest, parseScoreRequest, type TreatmentJob, runOutcome } from "./bench-requests";

// THE METHODS PAPER'S PAIRED COMPARISON, the Worker's half (job_ecb1b5f80c2d;
// capsid/research/design-paired-comparison.md, section 2; migrations/0047_bench.sql).
//
// The capsid-bench repo runs one task per GitHub Actions job per arm and talks to Capsid
// through four endpoints, signed like the improve scorer's (its own key, the Worker
// secret BENCH_SECRET, the same timestamp window, the same replay cache under its own
// scope) and not under /ops/ for the scorer's reason:
//
//   /bench/tasks  register a task and its hidden test counts, once
//   /bench/draw   record the registration and append the drawn task order
//   /bench/start  open a run, behind the off switch and the concurrency cap
//   /bench/repro  the harness's receipt for a treatment run's reproduction test
//   /bench/score  close it: the Worker computes resolved and the false success claim
//
// ONE CLAIM RULE FOR EVERY ARM. Each arm's claim is the claim file its run wrote with
// the bench's claim tool, read by capsid-bench's one parser and reported as claimed_done
// (the methods paper's protocol, section 3). The treatment's Capsid job is still checked
// to be this run's, but its status is not the claim.

export const BENCH_TASKS_PATH = "/bench/tasks";
export const BENCH_DRAW_PATH = "/bench/draw";
export const BENCH_START_PATH = "/bench/start";
export const BENCH_SCORE_PATH = "/bench/score";
export const BENCH_REPRO_PATH = "/bench/repro";

// The off switch: off unless it reads exactly "on". Absent, any other value or a read
// that fails is off, so a run never starts by default or by outage.
export const BENCH_ENABLED_KEY = "bench:enabled";
// At most this many runs at once, so a pilot never starves Dustin's own subscription use.
export const BENCH_MAX_RUNNING = 4;
// A running row older than BENCH_STALE_MS (src/bench-run-key.ts) no longer holds a
// slot: its job hit GitHub's own timeout without reporting. The row stays 'running' as
// the record of that.
// The design's k=3 repeats (D17): each model arm gets this many slots per task. A slot
// may be started twice, and the second start only when the first came back unjudged (a
// machine failure); a scored or running attempt holds its slot. Enforced here, not in the
// hand-dispatched workflow, so a run whose outcome was seen cannot be replaced by another
// start. A running row past BENCH_STALE_MS counts as unjudged.
export const BENCH_REPEATS = 3;
// THE ERROR STOP AND THE OUTAGE HOUR (the methods paper's protocol, section 3, revised
// 2026-10-22). A model run that ends with Claude Code's "error during execution" (a usage
// limit and a transport error look the same, and neither is classified) is scored from
// its diff and claim file the first time, as a clock kill is, and fills its slot. Except
// in an outage hour: a UTC hour in which at least BENCH_OUTAGE_MIN_ENDED model runs ended
// and at least half of them stopped this way. Such a stop counts as no attempt at all, so
// its slot is started once more, and no model run starts while the current hour already
// meets the rule.
//
// THE ORDER (section 5, "Order", decided 2026-10-22). A drawn task's six slots run in the
// fixed order baseline, treatment, baseline, treatment, baseline, treatment, each ended
// before the next starts, and a drawn task's first slot starts only when every task
// before it on the draw has ended all six.
const BENCH_OUTAGE_MIN_ENDED = 4;
const MODEL_ARMS: readonly Arm[] = ["baseline", "treatment"];
// The shared front of all three endpoints: bounded body, signature, then the parse,
// then the jti. The jti is spent only once the body is known good, as in the improve
// scorer's credential mint.
async function signedBody<T extends { jti: string }>(
  request: Request,
  env: Env,
  event: string,
  parse: (body: string) => ({ ok: true } & T) | Refusal
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const bounded = await readBoundedText(request, MAX_REPORT_BYTES);
  if (!bounded.ok) return { ok: false, response: textResponse(`request too large: exceeds ${MAX_REPORT_BYTES} bytes`, 413) };
  const verdict = await verifyBenchRequest(
    env,
    {
      timestamp: request.headers.get("X-Bench-Timestamp") ?? "",
      signature: request.headers.get("X-Bench-Signature") ?? "",
      body: bounded.text,
    },
    new Date()
  );
  if (!verdict.ok) {
    logEvent("error", event, { message: `${event} ${verdict.refusal}` });
    return { ok: false, response: textResponse(verdict.refusal, verdict.status) };
  }
  const parsed = parse(bounded.text);
  if (!parsed.ok) return { ok: false, response: textResponse(parsed.refusal, 400) };
  const claim = await claimJti(env.DB, JTI_SCOPE, parsed.jti);
  if (!claim.ok) return { ok: false, response: textResponse(claim.refusal, claim.status) };
  return { ok: true, value: parsed };
}

const TASK_FIELDS = ["source", "split", "repo", "issue_created_at", "fail_to_pass_count", "pass_to_pass_count"] as const;

export async function handleBenchTasks(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_TASKS_REJECTED", parseTaskRequest);
  if (!front.ok) return front.response;
  const t = front.value.task;
  const inserted = await env.DB.prepare(
    `INSERT INTO bench_tasks (task_id, source, split, repo, issue_created_at, fail_to_pass_count, pass_to_pass_count, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(task_id) DO NOTHING
     RETURNING task_id`
  )
    .bind(t.task_id, t.source, t.split, t.repo, t.issue_created_at, t.fail_to_pass_count, t.pass_to_pass_count, new Date().toISOString())
    .all<{ task_id: string }>();
  if (inserted.results.length === 1) return Response.json({ ok: true, task_id: t.task_id, registered: true });
  // Registered before. The same registration again is a no-op, so the loader can be
  // rerun; a different one is refused, because the registered list is the one scored.
  const existing = await env.DB.prepare(
    "SELECT source, split, repo, issue_created_at, fail_to_pass_count, pass_to_pass_count FROM bench_tasks WHERE task_id = ?1"
  )
    .bind(t.task_id)
    .first<Record<(typeof TASK_FIELDS)[number], string | number>>();
  const differs = existing ? TASK_FIELDS.filter((f) => existing[f] !== t[f]) : [];
  if (differs.length === 0) return Response.json({ ok: true, task_id: t.task_id, registered: false });
  return textResponse(`task ${t.task_id} is already registered with a different ${differs.join(", ")}; a registered task never changes`, 409);
}

// THE DRAW (the methods paper's protocol, section 4). The first call records the
// registration; every call must carry that same registration. tasks are the draw from
// position `from` on: positions already recorded must hold the same tasks, and the rest
// are appended in order, so a batch can be sent again and the draw only grows. A drawn
// task must be registered in the full split. One batch, so a refused task appends none.
export async function handleBenchDraw(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_DRAW_REJECTED", parseDrawRequest);
  if (!front.ok) return front.response;
  const { registration, from, tasks } = front.value;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO bench_registration (id, registration_sha256, frame_sha256, seed, recorded_at) VALUES (1, ?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO NOTHING`
  )
    .bind(registration.registration_sha256, registration.frame_sha256, registration.seed, now)
    .run();
  const recorded = await env.DB.prepare("SELECT registration_sha256, frame_sha256, seed FROM bench_registration WHERE id = 1").first<BenchRegistration>();
  const differs = recorded ? (["registration_sha256", "frame_sha256", "seed"] as const).filter((f) => recorded[f] !== registration[f]) : [];
  if (!recorded || differs.length > 0) {
    return textResponse(`a different registration is recorded (${differs.join(", ")}); a re-plan is a new registration, recorded by the seat before any confirmatory run`, 409);
  }
  const { results: drawn } = await env.DB.prepare("SELECT position, task_id FROM bench_draw WHERE position >= ?1 ORDER BY position")
    .bind(from)
    .all<{ position: number; task_id: string }>();
  const size = await env.DB.prepare("SELECT COUNT(*) AS n FROM bench_draw").first<{ n: number }>();
  const count = size?.n ?? 0;
  if (from > count + 1) return textResponse(`the draw holds ${count} tasks, so a batch starts at position ${count + 1} at the latest, not ${from}`, 409);
  for (const row of drawn) {
    const sent = tasks[row.position - from];
    if (sent !== undefined && sent !== row.task_id) return textResponse(`draw position ${row.position} holds ${row.task_id}, not ${sent}; the draw never changes`, 409);
  }
  const fresh = tasks.slice(count + 1 - from);
  if (fresh.length > 0) {
    const placeholders = fresh.map((_, i) => `?${i + 1}`).join(", ");
    const { results: full } = await env.DB.prepare(`SELECT task_id FROM bench_tasks WHERE split = 'full' AND task_id IN (${placeholders})`)
      .bind(...fresh)
      .all<{ task_id: string }>();
    const known = new Set(full.map((t) => t.task_id));
    const missing = fresh.filter((t) => !known.has(t));
    if (missing.length > 0) return textResponse(`not registered in the full split, so not drawn: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`, 409);
    try {
      await env.DB.batch(fresh.map((task_id, i) => env.DB.prepare("INSERT INTO bench_draw (position, task_id, recorded_at) VALUES (?1, ?2, ?3)").bind(count + 1 + i, task_id, now)));
    } catch (err) {
      return textResponse(`the draw was not extended (${err instanceof Error ? err.message : String(err)}); a task already drawn, or another batch landed at the same time`, 409);
    }
  }
  logEvent("log", "BENCH_DRAW_RECORDED", { message: `BENCH_DRAW_RECORDED added=${fresh.length} size=${count + fresh.length}` });
  return Response.json({ ok: true, added: fresh.length, size: count + fresh.length });
}

// THE REGISTRATION LOCK, for a model arm. A full-split task starts only once the
// registration is recorded and the task is on the draw. A pilot or excluded task starts
// only before it: the pilot checks feasibility and may change the budgets, and excluded
// (pre-cutoff) tasks are where the template is tuned (protocol section 2), so both
// precede the hash. Neither is sealed or analysed.
// The planted arms call no model and are not locked.
async function drawRefusal(db: D1Database, taskId: string, split: string): Promise<string | null> {
  const registered = await db.prepare("SELECT 1 AS one FROM bench_registration WHERE id = 1").first<{ one: number }>();
  if (split === "pilot" || split === "excluded") return registered ? `task ${taskId} is a ${split} task, and ${split} runs end when the registration is recorded` : null;
  if (!registered) return `no registration is recorded; record it and the draw with ${BENCH_DRAW_PATH} before a model run on a full-split task`;
  const drawn = await db.prepare("SELECT 1 AS one FROM bench_draw WHERE task_id = ?1").bind(taskId).first<{ one: number }>();
  return drawn ? null : `task ${taskId} is not on the draw`;
}

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
async function outageHours(db: D1Database, at: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT substr(finished_at, 1, 13) AS hour, COUNT(*) AS ended,
         SUM(CASE WHEN json_extract(report, '$.stopped_on_error') = 1 THEN 1 ELSE 0 END) AS errors
       FROM bench_runs WHERE arm IN ('baseline', 'treatment') AND finished_at IS NOT NULL AND finished_at <= ?1 GROUP BY hour`
    )
    .bind(at)
    .all<{ hour: string; ended: number; errors: number }>();
  return new Set(results.filter((h) => isOutageHour(h.ended, h.errors)).map((h) => h.hour));
}

/** The runs that count toward slots: an error stop in an outage hour is no attempt at all. */
export function countedRuns<T extends PriorRun>(runs: readonly T[], outage: ReadonlySet<string>): T[] {
  return runs.filter((r) => !(r.stopped_on_error && r.finished_at && outage.has(r.finished_at.slice(0, 13))));
}

// A task and arm's runs in start order, for the start's slot and the order rule.
async function priorRuns(db: D1Database, taskId: string, arm: string): Promise<(PriorRun & { id: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, started_at, finished_at, json_extract(report, '$.stopped_on_error') AS stopped_on_error
       FROM bench_runs WHERE task_id = ?1 AND arm = ?2 ORDER BY started_at, rowid`
    )
    .bind(taskId, arm)
    .all<PriorRun & { id: string }>();
  return results;
}

// Which slot and attempt the next start of a model arm on a task takes, from that task
// and arm's earlier runs in start order, or null when every slot is used. Slots fill in
// order, so a slot is identified by position: an unjudged first attempt leaves its slot
// waiting for its one rerun, and the next start fills that slot before opening another.
export function nextSlot(runs: readonly PriorRun[], staleBefore: string, repeats = BENCH_REPEATS): { slot: number; attempt: 1 | 2 } | null {
  let slot = 0;
  let waiting = false;
  for (const run of runs) {
    const unjudged = run.status === "unjudged" || (run.status === "running" && run.started_at <= staleBefore);
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
export function slotAt(runs: readonly PriorRun[], outage: ReadonlySet<string>, at: string): { slot: number; attempt: 1 | 2 } | null {
  const stood = runs.map((r) => (r.finished_at && r.finished_at <= at ? r : { ...r, status: "running", finished_at: null, stopped_on_error: null }));
  return nextSlot(countedRuns(stood, outage), new Date(Date.parse(at) - BENCH_STALE_MS).toISOString());
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
  earlierOpen: string | null
): string | null {
  if (arm === "baseline" && slot === 1 && earlierOpen) return `the draw runs in order: ${earlierOpen} has not ended its six slots`;
  const before = arm === "baseline" ? { arm: "treatment" as const, need: slot - 1 } : { arm: "baseline" as const, need: slot };
  if (running[before.arm] || done[before.arm] !== before.need) {
    return `the slots run baseline, treatment, baseline, treatment, baseline, treatment: ${arm} slot ${slot} starts when ${before.arm} has ended ${before.need} and none is running (it has ended ${done[before.arm]})`;
  }
  return null;
}

// The order rule's facts for a start, read from the database. Tasks off the draw (the
// pilot) have no order.
async function orderOf(db: D1Database, taskId: string, arm: Arm, slot: number, outage: ReadonlySet<string>, stale: string): Promise<string | null> {
  const row = await db.prepare("SELECT position FROM bench_draw WHERE task_id = ?1").bind(taskId).first<{ position: number }>();
  if (!row) return null;
  const state = async (id: string) => {
    const done = { baseline: 0, treatment: 0 };
    const running = { baseline: false, treatment: false };
    for (const a of MODEL_ARMS) {
      const runs = countedRuns(await priorRuns(db, id, a), outage);
      done[a as "baseline" | "treatment"] = slotsDone(runs, stale);
      running[a as "baseline" | "treatment"] = runs.some((r) => r.status === "running" && r.started_at > stale);
    }
    return { done, running };
  };
  let earlierOpen: string | null = null;
  if (arm === "baseline" && slot === 1) {
    const { results: earlier } = await db.prepare("SELECT task_id FROM bench_draw WHERE position < ?1 ORDER BY position").bind(row.position).all<{ task_id: string }>();
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

export async function handleBenchStart(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_START_REJECTED", parseStartRequest);
  if (!front.ok) return front.response;
  const { task_id, arm, gh_run } = front.value;
  let enabled: string | null;
  try {
    enabled = await env.APP_KV.get(BENCH_ENABLED_KEY);
  } catch (err) {
    return textResponse(`could not read ${BENCH_ENABLED_KEY} (${err instanceof Error ? err.message : String(err)}); a bench run starts only when it reads "on"`, 503);
  }
  if (enabled !== "on") return textResponse(`bench runs are off: ${BENCH_ENABLED_KEY} reads ${JSON.stringify(enabled)}, not "on"`, 403);
  const task = await env.DB.prepare("SELECT split FROM bench_tasks WHERE task_id = ?1").bind(task_id).first<{ split: string }>();
  if (!task) return textResponse(`no task ${task_id} is registered; register it with ${BENCH_TASKS_PATH} first`, 404);
  const now = new Date();
  if (arm === "treatment") {
    const breaker = await breakerState(env, BENCH_NAMESPACE, now);
    if (breaker.open) return textResponse(`no treatment run starts while the bench job breaker is open: ${breakerRefusal(breaker)}`, 409);
  }
  const id = `bench_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
  const stale = new Date(now.getTime() - BENCH_STALE_MS).toISOString();
  let slot: { slot: number; attempt: 1 | 2 } | null = null;
  let prior = -1;
  if (MODEL_ARMS.includes(arm)) {
    const locked = await drawRefusal(env.DB, task_id, task.split);
    if (locked) return textResponse(locked, 409);
    // A stale running row is closed as unjudged before its rerun can open, so its job can
    // no longer post a late score: /bench/score refuses a row that is not running.
    // A treatment row's job is closed with it (finishRun); one that moved in between is
    // left running, and the slot refusal below says so.
    const { results: staleRuns } = await env.DB.prepare(
      "SELECT id FROM bench_runs WHERE task_id = ?1 AND arm = ?2 AND status = 'running' AND started_at <= ?3"
    )
      .bind(task_id, arm, stale)
      .all<{ id: string }>();
    for (const { id: staleId } of staleRuns ?? []) {
      await finishRun(env, { id: staleId, task_id, arm }, now, [
        env.DB.prepare(
          `UPDATE bench_runs SET status = 'unjudged', finished_at = ?2, unjudged_reason = 'no report within the stale window; closed when the next start was asked for'
           WHERE id = ?1 AND status = 'running'`
        ).bind(staleId, now.toISOString()),
      ]);
    }
    const outage = await outageHours(env.DB, now.toISOString());
    if (outage.has(now.toISOString().slice(0, 13))) {
      return textResponse(`no model run starts in an outage hour: at least half of this hour's ended runs stopped with an error during execution; start again next hour`, 409);
    }
    const results = await priorRuns(env.DB, task_id, arm);
    slot = slotAt(results, outage, now.toISOString());
    if (!slot) {
      return textResponse(
        `task ${task_id} has used its ${arm} runs: ${BENCH_REPEATS} slots, each started at most twice and the second time only after an unjudged first attempt`,
        409
      );
    }
    const order = await orderOf(env.DB, task_id, arm, slot.slot, outage, stale);
    if (order) return textResponse(order, 409);
    prior = results.length;
  }
  // A treatment run's own key (src/bench-run-key.ts), returned once and stored only as
  // its hash on the row it opens.
  const runKey = arm === "treatment" ? newRunKey() : null;
  const runKeyHash = runKey ? await sha256Hex(runKey) : null;
  // One statement, so two starts racing for the last running slot cannot both take it,
  // and a model start counted against the rows read above fails if another start landed
  // since. The planted arms call no model and have no per-task slots.
  const opened = await env.DB.prepare(
    `INSERT INTO bench_runs (id, task_id, arm, gh_run, status, started_at, run_key_hash)
     SELECT ?1, ?2, ?3, ?4, 'running', ?5, ?9
     WHERE (SELECT COUNT(*) FROM bench_runs WHERE status = 'running' AND started_at > ?6) < ?7
       AND (?8 < 0 OR (SELECT COUNT(*) FROM bench_runs WHERE task_id = ?2 AND arm = ?3) = ?8)
     RETURNING id`
  )
    .bind(id, task_id, arm, gh_run, now.toISOString(), stale, BENCH_MAX_RUNNING, prior, runKeyHash)
    .all<{ id: string }>();
  if (opened.results.length !== 1) {
    if (prior >= 0) {
      const now2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM bench_runs WHERE task_id = ?1 AND arm = ?2").bind(task_id, arm).first<{ n: number }>();
      if ((now2?.n ?? prior) !== prior) return textResponse(`another ${arm} start for task ${task_id} landed at the same time; start again`, 409);
    }
    return textResponse(`${BENCH_MAX_RUNNING} bench runs are already running; try again when one finishes`, 429);
  }
  const at = slot ? ` slot=${slot.slot} attempt=${slot.attempt}` : "";
  logEvent("log", "BENCH_RUN_STARTED", { message: `BENCH_RUN_STARTED ${id} task=${task_id} arm=${arm} gh_run=${gh_run}${at}` });
  return Response.json({ ok: true, run_id: id, ...(slot ? { slot: slot.slot, attempt: slot.attempt } : {}), ...(runKey ? { run_key: runKey } : {}) });
}

// THE JOB CLOSE (the methods paper's protocol, section 4, "The job"; decided 2026-10-19).
// The score step finishes the run and closes that run's job in one batch, so the run is
// not finished unless the close commits with it, and the run key stops resolving in the
// same step (src/bench-run-key.ts reads a running row only). The close is a supersede by
// the harness with the same reason on every treatment run; a job with work recorded on
// it, which supersede refuses, is failed by the seat path with that reason, no claim and
// no outcome row, since it is not the holder's fail. Neither the run key nor the driver
// key that posted the job can supersede it. A stale run is closed by the same rule when
// the next start marks it unjudged. The analysis reads the claim file, never job status.
export const BENCH_CLOSE_REASON = "closed by the harness; the claim is the claim file";
const BENCH_HARNESS: Agent = {
  id: "bench-harness",
  name: "bench-harness",
  kind: "seat",
  actor: "bench-harness",
  scopes: { namespaces: [BENCH_NAMESPACE], repos: [], tools: ["capsid_work_jobs"], grants: ["read", "write"], flags: { ...noFlags(), can_merge: true } },
  admin: false,
  row: null,
};

/** Commits `rowClose` only while the run is running, with its job's close for a treatment run. False when nothing was written. */
async function finishRun(env: Env, run: { id: string; task_id: string; arm: Arm }, now: Date, rowClose: D1PreparedStatement[]): Promise<boolean> {
  const statements = [requireBenchRunRunning(env.DB, run.id), ...rowClose];
  if (run.arm === "treatment") {
    const open = await env.DB.prepare("SELECT id FROM jobs WHERE namespace = ?1 AND title = ?2 AND status IN ('queued', 'claimed', 'blocked')")
      .bind(BENCH_NAMESPACE, runJobTitle(run.task_id, run.id))
      .first<{ id: string }>();
    const job = open ? await readJob(env.DB, open.id) : null;
    if (job) {
      const failed = job.status === "blocked" || (job.status === "claimed" && workRecorded(job) !== null);
      const result = failed
        ? await adminFailJob(env, BENCH_HARNESS, now, job.id, BENCH_CLOSE_REASON, { extra: statements, outcome: false })
        : await supersedeJob(env, BENCH_HARNESS, now, job.id, { reason: BENCH_CLOSE_REASON }, statements);
      return result.ok;
    }
  }
  try {
    await env.DB.batch(statements);
    return true;
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return false;
  }
}

// The receipt is written once, for a running treatment run, and never changes: the
// harness checks once at the phase break (src/bench-run-key.ts, "THE REPRODUCTION RECEIPT").
export async function handleBenchRepro(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_REPRO_REJECTED", parseReproRequest);
  if (!front.ok) return front.response;
  const { run_id, passed, reason } = front.value;
  const run = await env.DB.prepare("SELECT arm, status FROM bench_runs WHERE id = ?1").bind(run_id).first<{ arm: Arm; status: string }>();
  if (!run) return textResponse(`no bench run ${run_id}`, 404);
  if (run.arm !== "treatment") return textResponse(`bench run ${run_id} is a ${run.arm} run; only a treatment run has a reproduction receipt`, 409);
  if (run.status !== "running") return textResponse(`bench run ${run_id} is already closed (${run.status})`, 409);
  if (await readReproReceipt(env.DB, run_id)) return textResponse(`bench run ${run_id} already has its reproduction receipt; it is written once`, 409);
  await auditStatement(env.DB, "system:bench-harness", BENCH_REPRO_ACTION, BENCH_NAMESPACE, run_id, { passed, reason }).run();
  return Response.json({ ok: true, run_id, passed });
}

export async function handleBenchScore(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_SCORE_REJECTED", parseScoreRequest);
  if (!front.ok) return front.response;
  const report = front.value.report;
  const run = await env.DB.prepare(
    `SELECT r.id, r.task_id, r.arm, r.status, t.split, t.fail_to_pass_count, t.pass_to_pass_count
     FROM bench_runs r JOIN bench_tasks t ON t.task_id = r.task_id WHERE r.id = ?1`
  )
    .bind(report.run_id)
    .first<{ id: string; task_id: string; arm: Arm; status: string; split: string; fail_to_pass_count: number; pass_to_pass_count: number }>();
  if (!run) return textResponse(`no bench run ${report.run_id}`, 404);
  if (run.status !== "running") return textResponse(`bench run ${run.id} is already closed (${run.status})`, 409);
  const job =
    run.arm === "treatment" && report.capsid_job_id
      ? await env.DB.prepare("SELECT namespace, title, status FROM jobs WHERE id = ?1").bind(report.capsid_job_id).first<TreatmentJob>()
      : null;
  const outcome = runOutcome(report, run, run, job);
  const scored = outcome.status === "scored";
  const flag = (v: boolean | null | undefined) => (v === undefined || v === null ? null : v ? 1 : 0);
  const u = report.usage;
  const finishedAt = new Date();
  const closeRow = env.DB.prepare(
    `UPDATE bench_runs SET status = ?2, finished_at = ?3, capsid_job_id = ?4, claimed_done = ?5, resolved = ?6, false_claim = ?7,
       fail_to_pass_passed = ?8, pass_to_pass_passed = ?9, unjudged_reason = ?10, model = ?11, claude_code_version = ?12,
       cost_usd = ?13, turns = ?14, duration_ms = ?15, input_tokens = ?16, output_tokens = ?17, cache_read_tokens = ?18,
       cache_creation_tokens = ?19, image_bytes = ?20, report = ?21
     WHERE id = ?1 AND status = 'running'`
  ).bind(
      run.id,
      outcome.status,
      finishedAt.toISOString(),
      report.capsid_job_id,
      flag(scored ? outcome.claimed_done : undefined),
      flag(scored ? outcome.resolved : undefined),
      flag(scored ? outcome.false_claim : undefined),
      report.hidden?.fail_to_pass.passed ?? null,
      report.hidden?.pass_to_pass.passed ?? null,
      scored ? null : outcome.reason,
      u.model,
      u.claude_code_version,
      u.cost_usd,
      u.turns,
      u.duration_ms,
      u.input_tokens,
      u.output_tokens,
      u.cache_read_tokens,
      u.cache_creation_tokens,
      report.image_bytes,
      JSON.stringify(report)
    );
  if (!(await finishRun(env, run, finishedAt, [closeRow]))) {
    // Two reports for one run racing: the first closed it, the second matched nothing.
    const after = await env.DB.prepare("SELECT status FROM bench_runs WHERE id = ?1").bind(run.id).first<{ status: string }>();
    if (after?.status !== "running") return textResponse(`bench run ${run.id} was closed by another report`, 409);
    return textResponse(`bench run ${run.id}'s job changed while it was being closed, so nothing was scored; send the report again`, 409);
  }
  logEvent("log", "BENCH_RUN_SCORED", { message: `BENCH_RUN_SCORED ${run.id} ${outcome.status}` });
  return Response.json({ ok: true, run_id: run.id, ...outcome });
}
