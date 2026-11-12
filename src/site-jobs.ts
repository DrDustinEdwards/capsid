import type { Env } from "./env";
import { exportAuditLog } from "@dustinedwards/site-runtime/audit-log";
import { describeRuns, runsSucceeded } from "@dustinedwards/site-runtime/cron";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { withAuditKey } from "./audit-key";
import { backupTaskResult, runBackup } from "./backup";
import { readSiteRow } from "./ops-sites";
import { callOperator, tokenSet, type FetchLike, type OperatorCall } from "./site-operator";
import { takeLimit } from "./site-repair";
import { auditStatement } from "./store-guards";
import { supersedePass } from "./supersede";
import { runTask, taskRunStatements, type TaskId, type TaskResult } from "./task-runs";

// RUN A SCHEDULED JOB NOW, ON ANY SITE (Dustin 2026-11-07, "can you just run them now"). One
// control, run_job { namespace, name }, in place of a "run now" copy of a job's work on each
// site (the four backup_media tools were such copies). Capsid never runs a site's work: it
// asks the site to run its own job through the code its cron runs.
//
//   a site     POST run_job { job: name } to its operator API, which runs the job through
//              site-runtime's runJobTool: the same runJobs path, cron_runs record and
//              timeout as its trigger, so /health's cron check sees the run. An admin MCP
//              server is its own site row (dustinedwards-admin-mcp, ...): its job is the
//              tool-call log's copy, tool-call-log-export, on its own /api/operator.
//   capsid     one of this Worker's own BACKUP_CRON jobs (CAPSID_JOBS), through runTask as
//              the cron runs it: the dump under the cron's lease, the tool-call log's copy
//              and the supersede pass, each with its task_runs row.
//
// Each call that leaves the Worker is an audit_log row (site-job) and a task_runs row
// (site-job). The rate limit is the repairs' one (src/site-repair.ts), keyed per job: two
// minutes between runs of a job on a site.

const JOB_AUDIT_ACTION = "site-job";
const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The namespace whose jobs are this Worker's own. */
export const CAPSID_NAMESPACE = "capsid";

// ---- Capsid's own jobs -------------------------------------------------------------------

type Judged = { ok: boolean; line: string };

/** Capsid's BACKUP_CRON jobs by name: the task each records under and its body with its judge. */
const CAPSID_JOB_BODIES = {
  backup: {
    task: "backup",
    tag: "BACKUP",
    run: (env: Env) => runBackup(env),
    judge: backupTaskResult,
  },
  // The tool-call log's daily copy to AUDIT_BUCKET and the 90-day prune of copied rows (area
  // 11, L6-L7). It throws on a failed write, so the run is recorded threw and /health's
  // tool-call-log check warns after two days. verified says whether the copy's chain checked.
  "tool-call-log-export": {
    task: "tool-call-log-export",
    tag: "TOOL_CALL_LOG_EXPORT",
    run: (env: Env) => exportAuditLog(withAuditKey(env), env.AUDIT_BUCKET),
    judge: (done: Awaited<ReturnType<typeof exportAuditLog>>): TaskResult => ({
      outcome: "ok",
      reason: `copied ${done.exported} rows in ${done.objects.length} objects; pruned ${done.pruned}; chain ${done.verified ? (done.verified.ok ? "verified" : `broken at ${done.verified.seq}: ${done.verified.reason}`) : "had nothing to verify"}`,
    }),
  },
  // design-hybrid-search 3.4.
  supersede: {
    task: "supersede",
    tag: "SUPERSEDE_PASS",
    run: (env: Env) => supersedePass(env),
    judge: (report: Awaited<ReturnType<typeof supersedePass>>): TaskResult => {
      if (report.marked.length === 0) return null;
      const line = report.marked.map((m) => `${m.document} by ${m.by}`).join("; ");
      return {
        outcome: "ok",
        reason: `marked ${report.marked.length} superseded${report.more ? " (more next pass)" : ""}: ${line}`,
      };
    },
  },
} as const satisfies Record<
  string,
  {
    task: TaskId;
    tag: string;
    run: (env: Env) => Promise<never> | Promise<unknown>;
    judge: (v: never) => TaskResult;
  }
>;

export type CapsidJob = keyof typeof CAPSID_JOB_BODIES;
export const CAPSID_JOBS = Object.keys(CAPSID_JOB_BODIES) as CapsidJob[];
const isCapsidJob = (name: string): name is CapsidJob => Object.hasOwn(CAPSID_JOB_BODIES, name);

/**
 * One of Capsid's own BACKUP_CRON jobs through runTask, as the cron runs it: the nightly
 * trigger passes rethrow, so a throw fails the invocation; a run now does not, and reads the
 * line. Each writes its own task_runs row.
 */
export async function runCapsidJob(env: Env, name: CapsidJob, rethrow: boolean): Promise<Judged> {
  const job = CAPSID_JOB_BODIES[name];
  let judged: TaskResult = null;
  await runTask(
    env,
    job.task,
    () => job.run(env) as Promise<unknown>,
    (value) => {
      judged = (job.judge as (v: unknown) => TaskResult)(value);
      return judged;
    },
    { tag: `${job.tag}${rethrow ? "_CRON" : "_NOW"}_THREW`, rethrow },
  );
  const result = judged as TaskResult;
  if (result)
    return {
      ok: result.outcome === "ok",
      line: `capsid ${name}: ${result.outcome}: ${result.reason}`,
    };
  return { ok: true, line: `capsid ${name}: ran, nothing to record` };
}

// ---- A site's jobs -----------------------------------------------------------------------

/** Why `name` cannot run on `namespace`, or null. Reads only, so the preview refuses what the run refuses. */
export async function jobRefusal(
  env: Env,
  namespace: string,
  name: string,
): Promise<string | null> {
  if (!JOB_NAME.test(name)) return `'${name}' is not a job name.`;
  if (namespace === CAPSID_NAMESPACE)
    return isCapsidJob(name)
      ? null
      : `Capsid's jobs that run now are ${CAPSID_JOBS.join(", ")}; '${name}' is not one.`;
  const row = await readSiteRow(env.DB, namespace);
  if (!row?.origin) return `${namespace} is not a configured site.`;
  if (!row.operator)
    return (
      row.operator_problem ??
      `${namespace} has no operator API configured, so Capsid may call nothing on it.`
    );
  if (!tokenSet(env, row.operator))
    return `the Capsid Worker secret ${row.operator.auth_var} is not set, so nothing can be called on ${namespace}.`;
  return null;
}

export type JobRun =
  | { ran: false; refusal: string }
  | { ran: true; ok: boolean; line: string; recorded: boolean };

/** Run `name` now on `namespace`: Capsid's own job in this Worker, or the site's through run_job. */
export async function runSiteJob(
  env: Env,
  args: { namespace: string; name: string; actor: string; via: string },
  now: Date,
  fetchImpl: FetchLike = fetch,
): Promise<JobRun> {
  const refusal = await jobRefusal(env, args.namespace, args.name);
  if (refusal) return { ran: false, refusal };
  if (args.namespace === CAPSID_NAMESPACE) {
    const done = await runCapsidJob(env, args.name as CapsidJob, false);
    return { ran: true, ok: done.ok, line: done.line, recorded: true };
  }
  const row = await readSiteRow(env.DB, args.namespace);
  if (!row?.origin || !row.operator)
    return { ran: false, refusal: `${args.namespace} is not a configured site.` };
  const site = { origin: row.origin, operator: row.operator };
  const wait = await takeLimit(env, args.namespace, `run_job:${args.name}`, now, false);
  if (wait) return { ran: false, refusal: `${args.name} on ${args.namespace} waits: ${wait}` };
  const started = new Date();
  const call = await callOperator(env, site, "run_job", fetchImpl, {
    job: true,
    args: { job: args.name },
  });
  const ok = runsSucceeded(call);
  const line = describeRuns("run_job", call);
  let recorded = true;
  try {
    await env.DB.batch([
      auditStatement(env.DB, args.actor, JOB_AUDIT_ACTION, args.namespace, null, {
        tool: "run_job",
        job: args.name,
        via: args.via,
        status: call.status,
        ok,
        error: call.error,
      }),
      ...taskRunStatements(
        env.DB,
        "site-job",
        started,
        new Date(),
        ok ? "ok" : "refused",
        `${args.namespace}: ${line} (${args.via})`,
      ),
    ]);
  } catch (err) {
    recorded = false;
    logEvent(
      "SITE_JOB_NOT_RECORDED",
      {
        message: `SITE_JOB_NOT_RECORDED ${args.namespace}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
  return { ran: true, ok, line, recorded };
}
