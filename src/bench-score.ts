import type { Env } from "./env";
import type { Agent } from "./agents";
import { noFlags } from "./agents-schema";
import { adminFailJob } from "./jobs-seat";
import { supersedeJob, workRecorded } from "./jobs-seat-supersede";
import { readJob } from "./jobs-transition";
import { auditStatement, isMissingRowAbort, requireBenchRunRunning } from "./store-guards";
import { textResponse } from "@dustinedwards/site-runtime/http";
import { logEvent } from "@dustinedwards/site-runtime/log";
import {
  BENCH_NAMESPACE,
  BENCH_REPRO_ACTION,
  readReproReceipt,
  runJobTitle,
} from "./bench-run-key";
import {
  type Arm,
  type TreatmentJob,
  parseReproRequest,
  parseScoreRequest,
  runOutcome,
  signedBody,
} from "./bench-requests";

// The score step finishes the run and closes its job in one batch, so the run is not finished
// unless the close commits with it, and the run key stops resolving in the same step. The analysis
// reads the claim file, never job status.
export const BENCH_CLOSE_REASON = "closed by the harness; the claim is the claim file";
const BENCH_HARNESS: Agent = {
  id: "bench-harness",
  name: "bench-harness",
  kind: "seat",
  actor: "bench-harness",
  scopes: {
    namespaces: [BENCH_NAMESPACE],
    repos: [],
    tools: ["capsid_work_jobs"],
    grants: ["read", "write"],
    flags: { ...noFlags(), can_merge: true },
  },
  admin: false,
  row: null,
};

export async function finishBenchRun(
  env: Env,
  run: { id: string; task_id: string; arm: Arm },
  now: Date,
  rowClose: D1PreparedStatement[],
): Promise<boolean> {
  const statements = [requireBenchRunRunning(env.DB, run.id), ...rowClose];
  if (run.arm === "treatment") {
    const open = await env.DB.prepare(
      "SELECT id FROM jobs WHERE namespace = ?1 AND title = ?2 AND status IN ('queued', 'claimed', 'blocked')",
    )
      .bind(BENCH_NAMESPACE, runJobTitle(run.task_id, run.id))
      .first<{ id: string }>();
    const job = open ? await readJob(env.DB, open.id) : null;
    if (job) {
      const failed =
        job.status === "blocked" || (job.status === "claimed" && workRecorded(job) !== null);
      const result = failed
        ? await adminFailJob(env, BENCH_HARNESS, now, job.id, BENCH_CLOSE_REASON, {
            extra: statements,
            outcome: false,
          })
        : await supersedeJob(
            env,
            BENCH_HARNESS,
            now,
            job.id,
            { reason: BENCH_CLOSE_REASON },
            statements,
          );
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

// The receipt is written once, for a running treatment run, and never changes: the harness checks
// once at the phase break (src/bench-run-key.ts, "THE REPRODUCTION RECEIPT").
export async function handleBenchRepro(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_REPRO_REJECTED", parseReproRequest);
  if (!front.ok) return front.response;
  const { run_id, passed, reason } = front.value;
  const run = await env.DB.prepare("SELECT arm, status FROM bench_runs WHERE id = ?1")
    .bind(run_id)
    .first<{ arm: Arm; status: string }>();
  if (!run) return textResponse(`no bench run ${run_id}`, 404);
  if (run.arm !== "treatment")
    return textResponse(
      `bench run ${run_id} is a ${run.arm} run; only a treatment run has a reproduction receipt`,
      409,
    );
  if (run.status !== "running")
    return textResponse(`bench run ${run_id} is already closed (${run.status})`, 409);
  if (await readReproReceipt(env.DB, run_id))
    return textResponse(
      `bench run ${run_id} already has its reproduction receipt; it is written once`,
      409,
    );
  await auditStatement(
    env.DB,
    "system:bench-harness",
    BENCH_REPRO_ACTION,
    BENCH_NAMESPACE,
    run_id,
    { passed, reason },
  ).run();
  return Response.json({ ok: true, run_id, passed });
}

export async function handleBenchScore(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_SCORE_REJECTED", parseScoreRequest);
  if (!front.ok) return front.response;
  const report = front.value.report;
  const run = await env.DB.prepare(
    `SELECT r.id, r.task_id, r.arm, r.status, t.split, t.fail_to_pass_count, t.pass_to_pass_count
     FROM bench_runs r JOIN bench_tasks t ON t.task_id = r.task_id WHERE r.id = ?1`,
  )
    .bind(report.run_id)
    .first<{
      id: string;
      task_id: string;
      arm: Arm;
      status: string;
      split: string;
      fail_to_pass_count: number;
      pass_to_pass_count: number;
    }>();
  if (!run) return textResponse(`no bench run ${report.run_id}`, 404);
  if (run.status !== "running")
    return textResponse(`bench run ${run.id} is already closed (${run.status})`, 409);
  if (report.diff !== null && run.split !== "excluded")
    return textResponse(
      `task ${run.task_id} is a ${run.split} task; a diff is kept only for an excluded (practice) task`,
      409,
    );
  const job =
    run.arm === "treatment" && report.capsid_job_id
      ? await env.DB.prepare("SELECT namespace, title, status FROM jobs WHERE id = ?1")
          .bind(report.capsid_job_id)
          .first<TreatmentJob>()
      : null;
  const outcome = runOutcome(report, run, run, job);
  const scored = outcome.status === "scored";
  const flag = (v: boolean | null | undefined) =>
    v === undefined || v === null ? null : v ? 1 : 0;
  const u = report.usage;
  const finishedAt = new Date();
  const closeRow = env.DB.prepare(
    `UPDATE bench_runs SET status = ?2, finished_at = ?3, capsid_job_id = ?4, claimed_done = ?5, resolved = ?6, false_claim = ?7,
       fail_to_pass_passed = ?8, pass_to_pass_passed = ?9, unjudged_reason = ?10, model = ?11, claude_code_version = ?12,
       cost_usd = ?13, turns = ?14, duration_ms = ?15, input_tokens = ?16, output_tokens = ?17, cache_read_tokens = ?18,
       cache_creation_tokens = ?19, image_bytes = ?20, report = ?21
     WHERE id = ?1 AND status = 'running'`,
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
    JSON.stringify(report),
  );
  if (!(await finishBenchRun(env, run, finishedAt, [closeRow]))) {
    const after = await env.DB.prepare("SELECT status FROM bench_runs WHERE id = ?1")
      .bind(run.id)
      .first<{ status: string }>();
    if (after?.status !== "running")
      return textResponse(`bench run ${run.id} was closed by another report`, 409);
    return textResponse(
      `bench run ${run.id}'s job changed while it was being closed, so nothing was scored; send the report again`,
      409,
    );
  }
  logEvent("BENCH_RUN_SCORED", { message: `BENCH_RUN_SCORED ${run.id} ${outcome.status}` });
  return Response.json({ ok: true, run_id: run.id, ...outcome });
}
