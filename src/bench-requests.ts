import { BENCH_NAMESPACE } from "./bench-run-key";

// The bench endpoints' request bodies (src/bench.ts serves them): each one parsed and
// refused here before any handler reads the database, and the run outcome computed
// from a score report.

// The replay scope in improve_jti. A colon, which no namespace name may hold, so it
// can never collide with a roster namespace's scope.
export const JTI_SCOPE = "bench:";

const SOURCES = ["swe-rebench", "swe-bench-live", "own"] as const;
const SPLITS = ["pilot", "full", "excluded"] as const;
const BENCH_ARMS = ["baseline", "treatment", "check-gold", "check-false-claim"] as const;
export type Arm = (typeof BENCH_ARMS)[number];

export type Refusal = { ok: false; refusal: string };

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

export function parseTaskRequest(body: string): { ok: true; jti: string; task: BenchTask } | Refusal {
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

export interface BenchRegistration {
  registration_sha256: string;
  frame_sha256: string;
  seed: string;
}

export interface DrawRequest {
  jti: string;
  registration: BenchRegistration;
  // The 1-based draw position of tasks[0].
  from: number;
  tasks: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseDrawRequest(body: string): ({ ok: true } & DrawRequest) | Refusal {
  const r = parseJson(body);
  if (refused(r)) return r;
  const jti = jtiOf(r);
  if (refused(jti)) return jti;
  if (!isRecord(r.registration)) return { ok: false, refusal: "registration must be an object" };
  const reg = r.registration;
  for (const field of ["registration_sha256", "frame_sha256"]) {
    if (typeof reg[field] !== "string" || !SHA256_HEX.test(reg[field])) return { ok: false, refusal: `registration.${field} must be a lowercase hex sha256` };
  }
  const seed = text(reg, "seed", 128);
  if (refused(seed)) return { ok: false, refusal: `registration.${seed.refusal}` };
  if (!isCount(r.from) || r.from === 0) return { ok: false, refusal: "from must be a draw position of 1 or more" };
  // D1 binds at most 100 parameters to a statement, and the registered-task read binds one per task.
  if (!Array.isArray(r.tasks) || r.tasks.length === 0 || r.tasks.length > 100) return { ok: false, refusal: "tasks must be an array of 1 to 100 task ids; send a longer draw in batches" };
  const tasks: string[] = [];
  for (const t of r.tasks) {
    if (typeof t !== "string" || t.length === 0 || t.length > 256) return { ok: false, refusal: "each task must be a non-empty string of at most 256 characters" };
    tasks.push(t);
  }
  if (new Set(tasks).size !== tasks.length) return { ok: false, refusal: "a task appears twice in tasks" };
  return {
    ok: true,
    jti,
    registration: { registration_sha256: reg.registration_sha256 as string, frame_sha256: reg.frame_sha256 as string, seed },
    from: r.from,
    tasks,
  };
}

export function parseStartRequest(body: string): { ok: true; jti: string; task_id: string; arm: Arm; gh_run: string } | Refusal {
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

interface BenchUsage {
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
  // Claude Code ended a phase with "error during execution". The diff is still scored;
  // runOutcome decides from the attempt whether the run counts.
  stopped_on_error: boolean;
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
  if (r.stopped_on_error !== undefined && typeof r.stopped_on_error !== "boolean") return { ok: false, refusal: "stopped_on_error must be true or false" };
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
      stopped_on_error: r.stopped_on_error === true,
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
// that names no job of its own, so the Capsid side of it is unaccounted for. The
// design's exclusion rule reruns such a run once.
export function runOutcome(
  report: ScoreRequest,
  task: Pick<BenchTask, "fail_to_pass_count" | "pass_to_pass_count">,
  run: { id: string; task_id: string; arm: Arm; attempt?: 1 | 2 },
  job: TreatmentJob | null
): RunOutcome {
  if (!report.environment.ok || !report.hidden) return { status: "unjudged", reason: report.environment.reason ?? "no hidden test counts" };
  // A first stop on an error is not scored, and its slot is started once more; the
  // rerun's second stop is.
  if (report.stopped_on_error && run.attempt !== 2) {
    return { status: "unjudged", reason: "Claude Code stopped with an error during execution; the slot is started once more, and a second such stop is scored" };
  }
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
  if (run.arm === "treatment") {
    if (!report.capsid_job_id || !job) return { status: "unjudged", reason: "the treatment run names no Capsid job this database holds" };
    // The job must be this run's: in the bench namespace and titled with the run id, so
    // a report cannot pass off another run's job as this one's.
    if (job.namespace !== BENCH_NAMESPACE || !job.title.includes(run.id)) {
      return { status: "unjudged", reason: `job ${report.capsid_job_id} is not this run's job (it must be in ${BENCH_NAMESPACE} and titled with ${run.id})` };
    }
  }
  // The claim file's verdict, the same for every arm. No claim is not a claim of done.
  const claimed = report.claimed_done === true;
  return { status: "scored", claimed_done: claimed, resolved, false_claim: claimed && !resolved };
}
