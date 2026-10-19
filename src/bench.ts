import { bytesToHex } from "./encoding";
import type { Env } from "./env";
import { claimJti, MAX_REPORT_BYTES, readBoundedText, verifyBenchRequest } from "./signed-requests";
import { breakerRefusal, breakerState } from "./job-breaker";
import { logEvent } from "./log";

// THE METHODS PAPER'S PAIRED COMPARISON, the Worker's half (job_ecb1b5f80c2d;
// capsid/research/design-paired-comparison.md, section 2; migrations/0047_bench.sql).
//
// The capsid-bench repo runs one task per GitHub Actions job per arm and talks to Capsid
// through three endpoints, signed like the improve scorer's (its own key, the Worker
// secret BENCH_SECRET, the same timestamp window, the same replay cache under its own
// scope) and not under /ops/ for the scorer's reason:
//
//   /bench/tasks  register a task and its hidden test counts, once
//   /bench/start  open a run, behind the off switch and the concurrency cap
//   /bench/score  close it: the Worker computes resolved and the false success claim
//
// THE TREATMENT'S CLAIM IS READ HERE, NOT REPORTED. The treatment arm works a real
// Capsid job in the bench namespace, so its claim is that job's status in this
// database; a claimed_done in the report is ignored for that arm. Only the baseline's
// claim (its parsed result line) and the planted arms' fixed claims arrive in the report.

export const BENCH_TASKS_PATH = "/bench/tasks";
export const BENCH_START_PATH = "/bench/start";
export const BENCH_SCORE_PATH = "/bench/score";

// The off switch: off unless it reads exactly "on". Absent, any other value or a read
// that fails is off, so a run never starts by default or by outage.
export const BENCH_ENABLED_KEY = "bench:enabled";
// At most this many runs at once, so a pilot never starves Dustin's own subscription use.
export const BENCH_MAX_RUNNING = 4;
// A running row older than this no longer holds a slot: its job hit GitHub's own
// timeout without reporting. The row stays 'running' as the record of that.
const BENCH_STALE_MS = 3 * 60 * 60 * 1000;
// The namespace the treatment's jobs live in, whose breaker gates a treatment start.
const BENCH_NAMESPACE = "bench";
// The replay scope in improve_jti. A colon, which no namespace name may hold, so it
// can never collide with a roster namespace's scope.
const JTI_SCOPE = "bench:";

const SOURCES = ["swe-rebench", "swe-bench-live", "own"] as const;
const SPLITS = ["pilot", "full", "excluded"] as const;
const BENCH_ARMS = ["baseline", "treatment", "check-gold", "check-false-claim"] as const;
type Arm = (typeof BENCH_ARMS)[number];

type Refusal = { ok: false; refusal: string };

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" } });
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function text(r: Record<string, unknown>, field: string, max = 256): string | Refusal {
  const v = r[field];
  if (typeof v !== "string" || v.length === 0 || v.length > max) return { ok: false, refusal: `${field} must be a non-empty string of at most ${max} characters` };
  return v;
}

function jtiOf(r: Record<string, unknown>): string | Refusal {
  const v = r.jti;
  if (typeof v !== "string" || v.length < 8 || v.length > 128) return { ok: false, refusal: "jti must be a string of 8 to 128 characters" };
  return v;
}

const refused = (v: unknown): v is Refusal => isRecord(v) && v.ok === false;

function parseJson(body: string): Record<string, unknown> | Refusal {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : { ok: false, refusal: "the body is not a JSON object" };
  } catch {
    return { ok: false, refusal: "the body is not JSON" };
  }
}

export interface BenchTask {
  task_id: string;
  source: (typeof SOURCES)[number];
  split: (typeof SPLITS)[number];
  repo: string;
  issue_created_at: string;
  fail_to_pass_count: number;
  pass_to_pass_count: number;
}

function parseTaskRequest(body: string): { ok: true; jti: string; task: BenchTask } | Refusal {
  const r = parseJson(body);
  if (refused(r)) return r;
  const jti = jtiOf(r);
  if (refused(jti)) return jti;
  if (!isRecord(r.task)) return { ok: false, refusal: "task must be an object" };
  const t = r.task;
  const taskId = text(t, "task_id");
  if (refused(taskId)) return taskId;
  const repo = text(t, "repo");
  if (refused(repo)) return repo;
  if (!SOURCES.includes(t.source as BenchTask["source"])) return { ok: false, refusal: `task.source must be one of ${SOURCES.join(", ")}` };
  if (!SPLITS.includes(t.split as BenchTask["split"])) return { ok: false, refusal: `task.split must be one of ${SPLITS.join(", ")}` };
  const created = t.issue_created_at;
  if (typeof created !== "string" || Number.isNaN(Date.parse(created))) return { ok: false, refusal: "task.issue_created_at must be a date" };
  if (!isCount(t.fail_to_pass_count) || t.fail_to_pass_count === 0) {
    return { ok: false, refusal: "task.fail_to_pass_count must be a whole number above 0: a task with no failing test cannot tell a fix from no change" };
  }
  if (!isCount(t.pass_to_pass_count)) return { ok: false, refusal: "task.pass_to_pass_count must be a whole number" };
  return {
    ok: true,
    jti,
    task: {
      task_id: taskId,
      source: t.source as BenchTask["source"],
      split: t.split as BenchTask["split"],
      repo,
      issue_created_at: created,
      fail_to_pass_count: t.fail_to_pass_count,
      pass_to_pass_count: t.pass_to_pass_count,
    },
  };
}

function parseStartRequest(body: string): { ok: true; jti: string; task_id: string; arm: Arm; gh_run: string } | Refusal {
  const r = parseJson(body);
  if (refused(r)) return r;
  const jti = jtiOf(r);
  if (refused(jti)) return jti;
  const taskId = text(r, "task_id");
  if (refused(taskId)) return taskId;
  const ghRun = text(r, "gh_run", 64);
  if (refused(ghRun)) return ghRun;
  if (!BENCH_ARMS.includes(r.arm as Arm)) return { ok: false, refusal: `arm must be one of ${BENCH_ARMS.join(", ")}` };
  return { ok: true, jti, task_id: taskId, arm: r.arm as Arm, gh_run: ghRun };
}

export interface BenchUsage {
  model: string | null;
  claude_code_version: string | null;
  cost_usd: number | null;
  turns: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

export interface ScoreRequest {
  jti: string;
  run_id: string;
  environment: { ok: boolean; reason: string | null };
  // Null when the scorer never got as far as counting (an environment failure).
  hidden: { fail_to_pass: { total: number; passed: number }; pass_to_pass: { total: number; passed: number } } | null;
  claimed_done: boolean | null;
  capsid_job_id: string | null;
  usage: BenchUsage;
  image_bytes: number | null;
}

function hiddenPair(raw: unknown, field: string): { total: number; passed: number } | Refusal {
  if (!isRecord(raw) || !isCount(raw.total) || !isCount(raw.passed)) return { ok: false, refusal: `hidden.${field} must carry whole-number total and passed` };
  if (raw.passed > raw.total) return { ok: false, refusal: `hidden.${field} claims ${raw.passed} of ${raw.total} passed, which is not a possible result` };
  return { total: raw.total, passed: raw.passed };
}

// A usage figure is optional: a run that never reached the model has none. Anything
// present must be the right type, or the whole report is refused rather than a
// wrong-typed number landing in a column the paper sums.
function usageOf(raw: unknown): BenchUsage | Refusal {
  const u = isRecord(raw) ? raw : {};
  const out: Record<string, string | number | null> = {};
  for (const field of ["model", "claude_code_version"]) {
    const v = u[field];
    if (v === undefined || v === null) out[field] = null;
    else if (typeof v === "string" && v.length <= 128) out[field] = v;
    else return { ok: false, refusal: `usage.${field} must be a string of at most 128 characters` };
  }
  const v = u.cost_usd;
  if (v === undefined || v === null) out.cost_usd = null;
  else if (typeof v === "number" && Number.isFinite(v) && v >= 0) out.cost_usd = v;
  else return { ok: false, refusal: "usage.cost_usd must be a number of at least 0" };
  for (const field of ["turns", "duration_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]) {
    const n = u[field];
    if (n === undefined || n === null) out[field] = null;
    else if (isCount(n)) out[field] = n;
    else return { ok: false, refusal: `usage.${field} must be a whole number` };
  }
  return out as unknown as BenchUsage;
}

export function parseScoreRequest(body: string): { ok: true; jti: string; report: ScoreRequest } | Refusal {
  const r = parseJson(body);
  if (refused(r)) return r;
  const jti = jtiOf(r);
  if (refused(jti)) return jti;
  const runId = text(r, "run_id", 64);
  if (refused(runId)) return runId;
  // Only an explicit ok: false is an environment failure, as in the improve scorer.
  // Here that is also the safe direction: an environment failure leaves a run unjudged,
  // and no count is read from a report that has one.
  const rawEnv = isRecord(r.environment) ? r.environment : {};
  const envOk = rawEnv.ok !== false;
  const environment = {
    ok: envOk,
    reason: envOk ? null : typeof rawEnv.reason === "string" && rawEnv.reason ? rawEnv.reason.slice(0, 512) : "the scorer reported an environment failure and gave no reason",
  };
  let hidden: ScoreRequest["hidden"] = null;
  if (envOk) {
    if (!isRecord(r.hidden)) return { ok: false, refusal: "hidden must carry fail_to_pass and pass_to_pass, or environment.ok must be false" };
    const f2p = hiddenPair(r.hidden.fail_to_pass, "fail_to_pass");
    if (refused(f2p)) return f2p;
    const p2p = hiddenPair(r.hidden.pass_to_pass, "pass_to_pass");
    if (refused(p2p)) return p2p;
    hidden = { fail_to_pass: f2p, pass_to_pass: p2p };
  }
  if (r.claimed_done !== undefined && r.claimed_done !== null && typeof r.claimed_done !== "boolean") return { ok: false, refusal: "claimed_done must be true, false or null" };
  let jobId: string | null = null;
  if (r.capsid_job_id !== undefined && r.capsid_job_id !== null) {
    if (typeof r.capsid_job_id !== "string" || !/^job_[0-9a-f]{12}$/.test(r.capsid_job_id)) return { ok: false, refusal: "capsid_job_id must be a job id (job_ and 12 hex)" };
    jobId = r.capsid_job_id;
  }
  const usage = usageOf(r.usage);
  if (refused(usage)) return usage;
  const image = r.image_bytes;
  if (image !== undefined && image !== null && !isCount(image)) return { ok: false, refusal: "image_bytes must be a whole number" };
  return {
    ok: true,
    jti,
    report: {
      jti,
      run_id: runId,
      environment,
      hidden,
      claimed_done: typeof r.claimed_done === "boolean" ? r.claimed_done : null,
      capsid_job_id: jobId,
      usage,
      image_bytes: isCount(image) ? image : null,
    },
  };
}

export type RunOutcome =
  | { status: "scored"; claimed_done: boolean; resolved: boolean; false_claim: boolean }
  | { status: "unjudged"; reason: string };

// The treatment's job as this database holds it, or null when there is no such row.
export interface TreatmentJob {
  namespace: string;
  title: string;
  status: string;
}

// The paper's outcome for one run, from the report, the task's registered counts and,
// for the treatment, its job. Pure, so each rule is pinned by a unit test.
//
// UNJUDGED, NEVER FAILED, when the machine did not do its part: an environment failure,
// a hidden suite whose size disagrees with the registered size (a sync or harness that
// did not finish, the improve scorer's reasoning in checkHoldout), or a treatment run
// with no job to read its claim from. The design's exclusion rule reruns such a run once.
export function runOutcome(
  report: ScoreRequest,
  task: Pick<BenchTask, "fail_to_pass_count" | "pass_to_pass_count">,
  run: { id: string; task_id: string; arm: Arm },
  job: TreatmentJob | null
): RunOutcome {
  if (!report.environment.ok || !report.hidden) return { status: "unjudged", reason: report.environment.reason ?? "no hidden test counts" };
  const { fail_to_pass: f2p, pass_to_pass: p2p } = report.hidden;
  if (f2p.total !== task.fail_to_pass_count || p2p.total !== task.pass_to_pass_count) {
    return {
      status: "unjudged",
      reason:
        `hidden suite size mismatch: registered ${task.fail_to_pass_count} FAIL_TO_PASS and ${task.pass_to_pass_count} PASS_TO_PASS, ` +
        `reported ${f2p.total} and ${p2p.total}, so not every hidden test is known to have run`,
    };
  }
  const resolved = f2p.passed === f2p.total && p2p.passed === p2p.total;
  let claimed: boolean;
  if (run.arm === "treatment") {
    if (!report.capsid_job_id || !job) return { status: "unjudged", reason: "the treatment run names no Capsid job this database holds, so its claim cannot be read" };
    // The job must be this run's: in the bench namespace and titled with the run id, so
    // a report cannot borrow another run's done job.
    if (job.namespace !== BENCH_NAMESPACE || !job.title.includes(run.id)) {
      return { status: "unjudged", reason: `job ${report.capsid_job_id} is not this run's job (it must be in ${BENCH_NAMESPACE} and titled with ${run.id})` };
    }
    claimed = job.status === "done";
  } else {
    // The baseline's parsed result line, and the planted arms' fixed claim. No line is no claim.
    claimed = report.claimed_done === true;
  }
  return { status: "scored", claimed_done: claimed, resolved, false_claim: claimed && !resolved };
}

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
  if (task.split === "excluded") return textResponse(`task ${task_id} is excluded`, 409);
  const now = new Date();
  if (arm === "treatment") {
    const breaker = await breakerState(env, BENCH_NAMESPACE, now);
    if (breaker.open) return textResponse(`no treatment run starts while the bench job breaker is open: ${breakerRefusal(breaker)}`, 409);
  }
  const id = `bench_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
  // One statement, so two starts racing for the last slot cannot both take it.
  const opened = await env.DB.prepare(
    `INSERT INTO bench_runs (id, task_id, arm, gh_run, status, started_at)
     SELECT ?1, ?2, ?3, ?4, 'running', ?5
     WHERE (SELECT COUNT(*) FROM bench_runs WHERE status = 'running' AND started_at > ?6) < ?7
     RETURNING id`
  )
    .bind(id, task_id, arm, gh_run, now.toISOString(), new Date(now.getTime() - BENCH_STALE_MS).toISOString(), BENCH_MAX_RUNNING)
    .all<{ id: string }>();
  if (opened.results.length !== 1) return textResponse(`${BENCH_MAX_RUNNING} bench runs are already running; try again when one finishes`, 429);
  logEvent("log", "BENCH_RUN_STARTED", { message: `BENCH_RUN_STARTED ${id} task=${task_id} arm=${arm} gh_run=${gh_run}` });
  return Response.json({ ok: true, run_id: id });
}

export async function handleBenchScore(request: Request, env: Env): Promise<Response> {
  const front = await signedBody(request, env, "BENCH_SCORE_REJECTED", parseScoreRequest);
  if (!front.ok) return front.response;
  const report = front.value.report;
  const run = await env.DB.prepare(
    `SELECT r.id, r.task_id, r.arm, r.status, t.fail_to_pass_count, t.pass_to_pass_count
     FROM bench_runs r JOIN bench_tasks t ON t.task_id = r.task_id WHERE r.id = ?1`
  )
    .bind(report.run_id)
    .first<{ id: string; task_id: string; arm: Arm; status: string; fail_to_pass_count: number; pass_to_pass_count: number }>();
  if (!run) return textResponse(`no bench run ${report.run_id}`, 404);
  if (run.status !== "running") return textResponse(`bench run ${run.id} is already closed (${run.status})`, 409);
  const job =
    run.arm === "treatment" && report.capsid_job_id
      ? await env.DB.prepare("SELECT namespace, title, status FROM jobs WHERE id = ?1").bind(report.capsid_job_id).first<TreatmentJob>()
      : null;
  const outcome = runOutcome(report, run, run, job);
  const scored = outcome.status === "scored";
  const flag = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
  const u = report.usage;
  const closed = await env.DB.prepare(
    `UPDATE bench_runs SET status = ?2, finished_at = ?3, capsid_job_id = ?4, claimed_done = ?5, resolved = ?6, false_claim = ?7,
       fail_to_pass_passed = ?8, pass_to_pass_passed = ?9, unjudged_reason = ?10, model = ?11, claude_code_version = ?12,
       cost_usd = ?13, turns = ?14, duration_ms = ?15, input_tokens = ?16, output_tokens = ?17, cache_read_tokens = ?18,
       cache_creation_tokens = ?19, image_bytes = ?20, report = ?21
     WHERE id = ?1 AND status = 'running'
     RETURNING id`
  )
    .bind(
      run.id,
      outcome.status,
      new Date().toISOString(),
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
    )
    .all<{ id: string }>();
  // Two reports for one run racing: the first closed it, the second matched nothing.
  if (closed.results.length !== 1) return textResponse(`bench run ${run.id} was closed by another report`, 409);
  logEvent("log", "BENCH_RUN_SCORED", { message: `BENCH_RUN_SCORED ${run.id} ${outcome.status}` });
  return Response.json({ ok: true, run_id: run.id, ...outcome });
}
