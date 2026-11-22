import type { Env } from "./env";
import { BENCH_REPEATS, MODEL_ARMS, orderOf, outageHours, priorRuns, slotAt } from "./bench-slots";
import { finishBenchRun } from "./bench-score";
import { breakerRefusal, breakerState } from "./job-breaker";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { BENCH_NAMESPACE, BENCH_STALE_MS, newRunKey } from "./bench-run-key";

import { textResponse } from "@dustinedwards/site-runtime/http";
import {
  parseTaskRequest,
  parseDrawRequest,
  type BenchRegistration,
  parseStartRequest,
  signedBody,
} from "./bench-requests";
import { sha256Hex, toHex } from "@dustinedwards/site-runtime/encoding";

// THE METHODS PAPER'S PAIRED COMPARISON, the Worker's half
// (capsid/research/design-paired-comparison.md, section 2; migrations/0047_bench.sql).
//
// The capsid-bench repo runs one task per GitHub Actions job per arm and talks to Capsid
// through endpoints signed like the improve scorer's (its own key, BENCH_SECRET, the same
// timestamp window, the replay cache under its own scope), not under /ops/:
//
//   /bench/tasks  register a task and its hidden test counts, once
//   /bench/draw   record the registration and append the drawn task order
//   /bench/start  open a run, behind the off switch and the concurrency cap
//   /bench/repro  the harness's receipt for a treatment run's reproduction test
//   /bench/score  close it: the Worker computes resolved and the false success claim
//
// ONE CLAIM RULE FOR EVERY ARM. Each arm's claim is the claim file its run wrote with the
// bench's claim tool, read by capsid-bench's one parser and reported as claimed_done
// (protocol section 3). The treatment's Capsid job status is not the claim.

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
// THE ERROR STOP AND THE OUTAGE HOUR (the methods paper's protocol, section 3).
// A model run that ends with Claude Code's "error during execution" (a usage
// limit and a transport error look the same, and neither is classified) is scored from
// its diff and claim file the first time, as a clock kill is, and fills its slot. Except
// in an outage hour: a UTC hour in which at least BENCH_OUTAGE_MIN_ENDED model runs ended
// and at least half of them stopped this way. Such a stop counts as no attempt at all, so
// its slot is started once more, and no model run starts while the current hour already
// meets the rule.
const TASK_FIELDS = [
  "source",
  "split",
  "repo",
  "issue_created_at",
  "fail_to_pass_count",
  "pass_to_pass_count",
] as const;

export async function handleBenchTasks(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_TASKS_REJECTED", parseTaskRequest);
  if (!front.ok) return front.response;
  const t = front.value.task;
  const inserted = await env.DB.prepare(
    `INSERT INTO bench_tasks (task_id, source, split, repo, issue_created_at, fail_to_pass_count, pass_to_pass_count, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(task_id) DO NOTHING
     RETURNING task_id`,
  )
    .bind(
      t.task_id,
      t.source,
      t.split,
      t.repo,
      t.issue_created_at,
      t.fail_to_pass_count,
      t.pass_to_pass_count,
      new Date().toISOString(),
    )
    .all<{ task_id: string }>();
  if (inserted.results.length === 1)
    return Response.json({ ok: true, task_id: t.task_id, registered: true });
  // Registered before. The same registration again is a no-op, so the loader can be
  // rerun; a different one is refused, because the registered list is the one scored.
  const existing = await env.DB.prepare(
    "SELECT source, split, repo, issue_created_at, fail_to_pass_count, pass_to_pass_count FROM bench_tasks WHERE task_id = ?1",
  )
    .bind(t.task_id)
    .first<Record<(typeof TASK_FIELDS)[number], string | number>>();
  const differs = existing ? TASK_FIELDS.filter((f) => existing[f] !== t[f]) : [];
  if (differs.length === 0)
    return Response.json({ ok: true, task_id: t.task_id, registered: false });
  return textResponse(
    `task ${t.task_id} is already registered with a different ${differs.join(", ")}; a registered task never changes`,
    409,
  );
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
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(registration.registration_sha256, registration.frame_sha256, registration.seed, now)
    .run();
  const recorded = await env.DB.prepare(
    "SELECT registration_sha256, frame_sha256, seed FROM bench_registration WHERE id = 1",
  ).first<BenchRegistration>();
  const differs = recorded
    ? (["registration_sha256", "frame_sha256", "seed"] as const).filter(
        (f) => recorded[f] !== registration[f],
      )
    : [];
  if (!recorded || differs.length > 0) {
    return textResponse(
      `a different registration is recorded (${differs.join(", ")}); a re-plan is a new registration, recorded by the seat before any confirmatory run`,
      409,
    );
  }
  const { results: drawn } = await env.DB.prepare(
    "SELECT position, task_id FROM bench_draw WHERE position >= ?1 ORDER BY position",
  )
    .bind(from)
    .all<{ position: number; task_id: string }>();
  const size = await env.DB.prepare("SELECT COUNT(*) AS n FROM bench_draw").first<{ n: number }>();
  const count = size?.n ?? 0;
  if (from > count + 1)
    return textResponse(
      `the draw holds ${count} tasks, so a batch starts at position ${count + 1} at the latest, not ${from}`,
      409,
    );
  for (const row of drawn) {
    const sent = tasks[row.position - from];
    if (sent !== undefined && sent !== row.task_id)
      return textResponse(
        `draw position ${row.position} holds ${row.task_id}, not ${sent}; the draw never changes`,
        409,
      );
  }
  const fresh = tasks.slice(count + 1 - from);
  if (fresh.length > 0) {
    const placeholders = fresh.map((_, i) => `?${i + 1}`).join(", ");
    const { results: full } = await env.DB.prepare(
      `SELECT task_id FROM bench_tasks WHERE split = 'full' AND task_id IN (${placeholders})`,
    )
      .bind(...fresh)
      .all<{ task_id: string }>();
    const known = new Set(full.map((t) => t.task_id));
    const missing = fresh.filter((t) => !known.has(t));
    if (missing.length > 0)
      return textResponse(
        `not registered in the full split, so not drawn: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
        409,
      );
    try {
      await env.DB.batch(
        fresh.map((task_id, i) =>
          env.DB.prepare(
            "INSERT INTO bench_draw (position, task_id, recorded_at) VALUES (?1, ?2, ?3)",
          ).bind(count + 1 + i, task_id, now),
        ),
      );
    } catch (err) {
      return textResponse(
        `the draw was not extended (${errorMessage(err)}); a task already drawn, or another batch landed at the same time`,
        409,
      );
    }
  }
  logEvent("BENCH_DRAW_RECORDED", {
    message: `BENCH_DRAW_RECORDED added=${fresh.length} size=${count + fresh.length}`,
  });
  return Response.json({ ok: true, added: fresh.length, size: count + fresh.length });
}

// THE REGISTRATION LOCK, for a model arm. A full-split task starts only once the
// registration is recorded and the task is on the draw. A pilot or excluded task starts
// only before it: the pilot checks feasibility and may change the budgets, and excluded
// (pre-cutoff) tasks are where the template is tuned (protocol section 2), so both
// precede the hash. Neither is sealed or analyzed.
// The planted arms call no model and are not locked.
async function drawRefusal(db: D1Database, taskId: string, split: string): Promise<string | null> {
  const registered = await db
    .prepare("SELECT 1 AS one FROM bench_registration WHERE id = 1")
    .first<{ one: number }>();
  if (split === "pilot" || split === "excluded")
    return registered
      ? `task ${taskId} is a ${split} task, and ${split} runs end when the registration is recorded`
      : null;
  if (!registered)
    return `no registration is recorded; record it and the draw with ${BENCH_DRAW_PATH} before a model run on a full-split task`;
  const drawn = await db
    .prepare("SELECT 1 AS one FROM bench_draw WHERE task_id = ?1")
    .bind(taskId)
    .first<{ one: number }>();
  return drawn ? null : `task ${taskId} is not on the draw`;
}

export async function handleBenchStart(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_START_REJECTED", parseStartRequest);
  if (!front.ok) return front.response;
  const { task_id, arm, gh_run } = front.value;
  let enabled: string | null;
  try {
    enabled = await env.APP_KV.get(BENCH_ENABLED_KEY);
  } catch (err) {
    return textResponse(
      `could not read ${BENCH_ENABLED_KEY} (${errorMessage(err)}); a bench run starts only when it reads "on"`,
      503,
    );
  }
  if (enabled !== "on")
    return textResponse(
      `bench runs are off: ${BENCH_ENABLED_KEY} reads ${JSON.stringify(enabled)}, not "on"`,
      403,
    );
  const task = await env.DB.prepare("SELECT split FROM bench_tasks WHERE task_id = ?1")
    .bind(task_id)
    .first<{ split: string }>();
  if (!task)
    return textResponse(
      `no task ${task_id} is registered; register it with ${BENCH_TASKS_PATH} first`,
      404,
    );
  const now = new Date();
  if (arm === "treatment") {
    const breaker = await breakerState(env, BENCH_NAMESPACE, now);
    if (breaker.open)
      return textResponse(
        `no treatment run starts while the bench job breaker is open: ${breakerRefusal(breaker)}`,
        409,
      );
  }
  const id = `bench_${toHex(crypto.getRandomValues(new Uint8Array(6)))}`;
  const stale = new Date(now.getTime() - BENCH_STALE_MS).toISOString();
  let slot: { slot: number; attempt: 1 | 2 } | null = null;
  let prior = -1;
  if (MODEL_ARMS.includes(arm)) {
    const locked = await drawRefusal(env.DB, task_id, task.split);
    if (locked) return textResponse(locked, 409);
    // A stale running row is closed as unjudged before its rerun can open, so its job can
    // no longer post a late score: /bench/score refuses a row that is not running.
    // A treatment row's job is closed with it (finishBenchRun); one that moved in between is
    // left running, and the slot refusal below says so.
    const { results: staleRuns } = await env.DB.prepare(
      "SELECT id FROM bench_runs WHERE task_id = ?1 AND arm = ?2 AND status = 'running' AND started_at <= ?3",
    )
      .bind(task_id, arm, stale)
      .all<{ id: string }>();
    for (const { id: staleId } of staleRuns ?? []) {
      await finishBenchRun(env, { id: staleId, task_id, arm }, now, [
        env.DB.prepare(
          `UPDATE bench_runs SET status = 'unjudged', finished_at = ?2, unjudged_reason = 'no report within the stale window; closed when the next start was asked for'
           WHERE id = ?1 AND status = 'running'`,
        ).bind(staleId, now.toISOString()),
      ]);
    }
    const outage = await outageHours(env.DB, now.toISOString());
    if (outage.has(now.toISOString().slice(0, 13))) {
      return textResponse(
        `no model run starts in an outage hour: at least half of this hour's ended runs stopped with an error during execution; start again next hour`,
        409,
      );
    }
    const results = await priorRuns(env.DB, task_id, arm);
    slot = slotAt(results, outage, now.toISOString());
    if (!slot) {
      return textResponse(
        `task ${task_id} has used its ${arm} runs: ${BENCH_REPEATS} slots, each started at most twice and the second time only after an unjudged first attempt`,
        409,
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
     RETURNING id`,
  )
    .bind(id, task_id, arm, gh_run, now.toISOString(), stale, BENCH_MAX_RUNNING, prior, runKeyHash)
    .all<{ id: string }>();
  if (opened.results.length !== 1) {
    if (prior >= 0) {
      const now2 = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM bench_runs WHERE task_id = ?1 AND arm = ?2",
      )
        .bind(task_id, arm)
        .first<{ n: number }>();
      if ((now2?.n ?? prior) !== prior)
        return textResponse(
          `another ${arm} start for task ${task_id} landed at the same time; start again`,
          409,
        );
    }
    return textResponse(
      `${BENCH_MAX_RUNNING} bench runs are already running; try again when one finishes`,
      429,
    );
  }
  const at = slot ? ` slot=${slot.slot} attempt=${slot.attempt}` : "";
  logEvent("BENCH_RUN_STARTED", {
    message: `BENCH_RUN_STARTED ${id} task=${task_id} arm=${arm} gh_run=${gh_run}${at}`,
  });
  return Response.json({
    ok: true,
    run_id: id,
    ...(slot ? { slot: slot.slot, attempt: slot.attempt } : {}),
    ...(runKey ? { run_key: runKey } : {}),
  });
}
