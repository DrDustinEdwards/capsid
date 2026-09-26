import { base64Decode } from "../encoding";
import { SCORER_WORKFLOW } from "../improve-schema";
import type { AttemptEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  ghFetch,
  resolveRepo,
} from "./client";

// Recent CI workflow runs for a namespace's repo, via the GitHub App. Read-only.
// For the most recent failed run it also returns the failing jobs and steps and a
// bounded log tail. Needs the App's Actions: Read permission; a 403 is surfaced as
// a named error.
//
// The log tail is withheld from read-only keys. Run metadata (name, sha, conclusion)
// is inert; a build log carries whatever the workflow echoed: resolved binding ids,
// account ids, wrangler output, and any variable a step printed by accident. The runs
// list stays open to read-only keys.

// A ref matching this shape is filtered as a head sha, anything else as a branch.
// GitHub has two query parameters for these and none that accepts either, so the
// tool takes one `ref` and decides here.
const SHA_SHAPE = /^[0-9a-f]{7,40}$/i;

export async function ciStatus(
  env: Env,
  namespace: string,
  repoSelector?: string,
  opts: { limit?: number; logTail?: boolean; ref?: string; runId?: number } = {}
) {
  if (opts.ref) assertRepoArg("ref", opts.ref);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 20) : 10;
  let query = `/repos/${owner}/${repo}/actions/runs?per_page=${limit}`;
  if (opts.runId) {
    // One run, by id. Wrapped back into the list's shape so the failed-run drill-in
    // has one code path.
    const one = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${opts.runId}`);
    if (one.status === 404) throw new Error(`ci_status: run ${opts.runId} does not exist on ${full}`);
    if (!one.ok) throw new Error(`ci_status run lookup failed (${one.status}): ${(await one.text()).slice(0, 200)}`);
    const run = await one.json();
    return ciStatusFromRuns(env, owner, repo, full, [run as CiRun], opts.logTail === true, { run_id: opts.runId });
  }
  if (opts.ref) {
    if (SHA_SHAPE.test(opts.ref)) {
      // An abbreviated sha is expanded first. GitHub matches head_sha exactly and
      // documents nothing, so a short sha returns an empty run list rather than an
      // error. One extra GET, only when the ref is short.
      let full40 = opts.ref;
      if (opts.ref.length < 40) {
        const commit = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/commits/${encodeURIComponent(opts.ref)}`);
        if (!commit.ok) {
          throw new Error(
            `ci_status: ${opts.ref} does not resolve to a commit on ${full} (${commit.status}), so runs cannot be filtered by it`
          );
        }
        full40 = ((await commit.json()) as { sha: string }).sha;
      }
      query += `&head_sha=${encodeURIComponent(full40)}`;
    } else {
      query += `&branch=${encodeURIComponent(opts.ref)}`;
    }
  }
  const resp = await ghFetch(env, owner, repo, query);
  if (resp.status === 403) {
    throw new Error(
      "ci_status: the capsid-repo-access GitHub App lacks Actions: Read. Add that permission in the App settings and accept the installation prompt, then retry."
    );
  }
  if (!resp.ok) throw new Error(`ci_status failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { workflow_runs: CiRun[] };
  return ciStatusFromRuns(env, owner, repo, full, data.workflow_runs, opts.logTail === true, opts.ref ? { ref: opts.ref } : {});
}

interface CiRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  html_url: string;
}

// The failing step's log, 64KB from its end, for write-grant keys. A job log ends
// with post-run cleanup, so the last few thousand characters of a failed run are
// `git config --unset-all` lines and the failure is far earlier. The region is found
// by the failing step and then tailed. The read-only tier is unchanged.
export const CI_LOG_BUDGET = 64 * 1024;

// Actions labels groups by command, not step name, so a step's name appears nowhere
// in its own log and a name search matches an incidental later occurrence. The
// failing step is found by its started_at..completed_at window instead: every log
// line carries an ISO timestamp.
//
// The jobs API truncates those to the second while log lines carry sub-second
// stamps, so the upper bound is extended to the end of that second, or the last
// second of output (where the error is) is dropped. Truncating down only widens the
// lower bound, so `from` needs no adjustment.
const STEP_STAMP_PRECISION_MS = 1000;
function failingStepLog(
  log: string,
  step: { name?: string; started_at?: string | null; completed_at?: string | null } | undefined
): { text: string; how: string } {
  const name = step?.name;
  const from = step?.started_at ? Date.parse(step.started_at) : NaN;
  const to = step?.completed_at ? Date.parse(step.completed_at) : NaN;

  if (Number.isFinite(from) && Number.isFinite(to)) {
    const windowed = log
      .split("\n")
      .filter((line) => {
        const stamp = /^(\S+Z)/.exec(line);
        if (!stamp) return false;
        const at = Date.parse(stamp[1]);
        return Number.isFinite(at) && at >= from && at < to + STEP_STAMP_PRECISION_MS;
      })
      .join("\n");
    if (windowed.length > 0) {
      return {
        text: windowed.length > CI_LOG_BUDGET ? windowed.slice(-CI_LOG_BUDGET) : windowed,
        how:
          windowed.length > CI_LOG_BUDGET
            ? `failing step "${name}" by timestamp window, last ${CI_LOG_BUDGET} bytes of it`
            : `failing step "${name}" by timestamp window, whole (${windowed.length} bytes)`,
      };
    }
  }

  // NAMED FALLBACK, not a silent one. "The end of the job log" and "the failing
  // step" are different claims and the caller is told which one this is.
  return {
    text: log.slice(-CI_LOG_BUDGET),
    how: name
      ? `step "${name}" had no usable timestamp window, so this is the last ${CI_LOG_BUDGET} bytes of the whole job, cleanup included`
      : `no failing step was named, so this is the last ${CI_LOG_BUDGET} bytes of the whole job, cleanup included`,
  };
}

async function ciStatusFromRuns(
  env: Env,
  owner: string,
  repo: string,
  full: string,
  workflowRuns: CiRun[],
  logTail: boolean,
  filter: { ref?: string; run_id?: number }
) {
  const runs = workflowRuns.map((r) => ({
    name: r.name,
    head_sha: r.head_sha?.slice(0, 7),
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    created_at: r.created_at,
    url: r.html_url,
  }));

  const result: {
    repo: string;
    filter?: { ref?: string; run_id?: number };
    runs: typeof runs;
    failed_run?: unknown;
  } = { repo: full, runs };
  if (filter.ref || filter.run_id) result.filter = filter;

  // Drill into the most recent failed run so the caller sees why, not just that.
  // Every degraded path is named: an errored jobs fetch or log fetch is reported
  // rather than dropped, so a write-grant caller can tell "no log" from "the log was
  // refused for you".
  const failed = workflowRuns.find((r) => r.conclusion === "failure");
  if (failed) {
    const failedRun: Record<string, unknown> = {
      name: failed.name,
      head_sha: failed.head_sha?.slice(0, 7),
      url: failed.html_url,
    };
    const jobsResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${failed.id}/jobs`);
    if (!jobsResp.ok) {
      failedRun.jobs_unavailable = `${jobsResp.status}: ${(await jobsResp.text()).slice(0, 200) || "no response body"}`;
    } else {
      const jobsData = (await jobsResp.json()) as {
        jobs: Array<{
          id: number;
          name: string;
          conclusion: string | null;
          steps?: Array<{ name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }>;
        }>;
      };
      failedRun.jobs = jobsData.jobs
        .filter((j) => j.conclusion === "failure")
        .map((j) => ({
          name: j.name,
          failed_steps: (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name),
        }));
      const firstFailedJob = jobsData.jobs.find((j) => j.conclusion === "failure");
      if (!logTail) {
        // Unchanged: this is the read-only tier's boundary, not a degraded path.
        failedRun.log_tail_withheld =
          "read-only key: run metadata only. A write-grant key returns the failing step's log.";
      } else if (!firstFailedJob) {
        failedRun.log_tail_unavailable = "the run is marked failed but no job in it is, so there is no job log to read";
      } else {
        const logResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/jobs/${firstFailedJob.id}/logs`);
        if (logResp.ok) {
          const failedStep = (firstFailedJob.steps ?? []).find((s) => s.conclusion === "failure");
          const picked = failingStepLog(await logResp.text(), failedStep);
          failedRun.failing_job = firstFailedJob.name;
          failedRun.failing_step = failedStep?.name ?? null;
          failedRun.log_region = picked.how;
          failedRun.log = picked.text;
        } else {
          failedRun.log_tail_unavailable = `${logResp.status}: ${(await logResp.text()).slice(0, 200) || "no response body"}`;
        }
      }
    }
    result.failed_run = failedRun;
  }
  return result;
}

// Fire a workflow_dispatch. workflow_dispatch runs the workflow file as it exists at
// `ref`, so the improve loop dispatches against the default branch and passes the
// attempt branch as an input: an attempt cannot rewrite its own scorer.
//
// The deterministic monitor also refuses any diff touching .github/. Both are kept:
// the monitor is a policy that could be relaxed, this is a mechanism.
//
// `refOverride` exists for ci_dispatch, where a human asking for a branch means that
// branch. Do not pass it at the improve loop's call site.
export async function dispatchWorkflow(
  env: Env,
  namespace: string,
  workflowFile: string,
  inputs: Record<string, string>,
  repoSelector?: string,
  refOverride?: string
): Promise<{ repo: string; workflow: string; ref: string; inputs: Record<string, string> }> {
  assertRepoArg("workflow", workflowFile);
  if (refOverride) assertRepoArg("ref", refOverride);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const ref = refOverride ?? (await getDefaultBranch(env, owner, repo));
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs }),
    }
  );
  // 204 is the success code here, and there is no body to read on either path.
  if (!resp.ok) {
    throw new Error(
      `workflow dispatch failed for ${full} ${workflowFile} (${resp.status}): ${(await resp.text()).slice(0, 300) || "no response body"}`
    );
  }
  return { repo: full, workflow: workflowFile, ref, inputs };
}

// What CI is doing on one branch. Read by the tick so a timeout can name WHICH
// failure it was: the workflow never started, it is still running, or it finished
// and the report never arrived. Those three have different fixes.
//
// `id` and `head_sha` are for ci_dispatch: workflow_dispatch replies 204 with no
// body, so naming the run it started means looking for one that did not exist before.
export async function workflowRunsForBranch(
  env: Env,
  namespace: string,
  branch: string,
  repoSelector?: string
): Promise<
  Array<{
    id: number;
    head_sha: string;
    name: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
    url: string;
  }>
> {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`
  );
  if (!resp.ok) throw new Error(`workflow run lookup failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as {
    workflow_runs: Array<{
      id: number;
      head_sha: string;
      name: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>;
  };
  return data.workflow_runs.map((r) => ({
    id: r.id,
    head_sha: r.head_sha,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    created_at: r.created_at,
    updated_at: r.updated_at,
    url: r.html_url,
  }));
}

// What makes a workflow a scorer, regardless of its file name: it posts a signed
// report to this path. Used by ci_dispatch's content check.
const SCORE_PATH_MARKER = "/improve/score";

export const CI_DISPATCH_POLL_MS = 30_000;
export const CI_DISPATCH_POLL_INTERVAL_MS = 3_000;

// The scorer is not hand-dispatchable through this tool: it signs whatever it
// measured with the repo's score key, so a dispatch against an arbitrary ref mints a
// genuinely signed report. Ingest also binds the report to the run's in-flight
// attempt and head sha, but that is the second lock. The loop dispatches its own
// scorer through dispatchWorkflow (src/improve/tick.ts); a human shakedown goes
// through GitHub.
//
// GitHub's dispatch endpoint accepts a numeric id or a full path as well as a file
// name, so the refusal matches what the workflow is, not one spelling of its name,
// in three checks in cost order. Checks 1 and 2 need no lookup and run here.
function refuseScorerByName(workflow: string): void {
  // 1. Shape. A workflow is a YAML file in .github/workflows. A numeric id is not
  //    a name this tool accepts, which closes the alias without a lookup.
  const basename = workflow.split("/").pop() ?? "";
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(basename)) {
    throw new Error(
      `ci_dispatch refuses: '${workflow}' is not a workflow file name. Pass the file name (for example ci.yml). A numeric workflow id is refused because it names the same file by a different route and defeats the scorer refusal below.`
    );
  }
  // 2. Name, on the basename, so a full path spelling is caught too.
  if (basename === SCORER_WORKFLOW) {
    throw new Error(
      `ci_dispatch refuses: ${SCORER_WORKFLOW} is the improve loop's scorer, and a hand dispatch of it can mint a signed score report for an arbitrary ref. The loop dispatches it itself; run a shakedown from GitHub directly.`
    );
  }
}

// 3. CONTENT. A scorer renamed, copied or vendored under another file name still
//    holds the signing key and posts to the score endpoint. Read the file on the
//    default branch and, when a ref is given, on that ref too, and refuse anything
//    that declares it. A read failure does NOT refuse: a workflow this tool cannot
//    see is ordinary for a repo whose default branch differs, and failing closed here
//    would break ci_dispatch on a network blip. Checks 1 and 2 hold without a lookup.
async function refuseScorerByContent(
  env: Env,
  target: { owner: string; repo: string; full: string },
  workflow: string,
  ref: string | undefined
): Promise<void> {
  const { owner, repo, full } = target;
  // Both copies are checked. The dispatch runs the workflow as it exists on ref, so
  // a scorer added or renamed on a feature branch is only visible there. The default
  // branch still matters, because GitHub only makes a workflow dispatchable if it is
  // on the default branch, so a rename there is the other half of the same trick.
  // Refusing if either copy is a scorer covers both.
  const path = encodePath(`.github/workflows/${workflow.split("/").pop()}`);
  const refs = ref ? [undefined, ref] : [undefined];
  for (const at of refs) {
    try {
      const query = at ? `?ref=${encodeURIComponent(at)}` : "";
      const resp = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/contents/${path}${query}`);
      if (resp.ok) {
        const data = (await resp.json()) as { content?: string; encoding?: string };
        const body = data.encoding === "base64" && data.content ? base64Decode(data.content) : "";
        if (body.includes(SCORE_PATH_MARKER)) {
          throw new Error(
            `ci_dispatch refuses: ${workflow} on ${full}${at ? ` at ${at}` : ""} posts to ${SCORE_PATH_MARKER}, which makes it a scorer whatever it is called. A hand dispatch of it can mint a signed score report for an arbitrary ref.`
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ci_dispatch refuses")) throw err;
      // A lookup problem, not a verdict. Named, not swallowed, and fail-open as
      // stated above: checks 1 and 2 hold without a lookup.
      console.log(`CI_DISPATCH_CONTENT_CHECK_SKIPPED ${full} ${workflow}${at ? ` @${at}` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Rerunning the scorer's failed jobs re-executes the signing step against that run's
// ref, so a scorer run is refused.
async function rerunFailedJobs(env: Env, target: { owner: string; repo: string; full: string }, runId: number) {
  const { owner, repo, full } = target;
  const runResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${runId}`);
  // A run this cannot identify is not rerun: otherwise whatever made the GET fail
  // would also skip the one lookup that decides whether this is the scorer.
  //
  // Fail closed here, unlike the content check, because of what the lookup is for:
  // there, a missing file leaves two other checks standing; here, this is the only
  // thing between a caller and re-executing the signing step.
  if (!runResp.ok) {
    throw new Error(
      `ci_dispatch refuses: run ${runId} on ${full} could not be read (${runResp.status}), so whether it is a ${SCORER_WORKFLOW} run is unknown. A rerun re-executes that run's jobs with this repo's secrets, so an unidentified run is not rerun.`
    );
  }
  const runData = (await runResp.json()) as { path?: string; name?: string };
  const runBasename = (runData.path ?? "").split("/").pop() ?? "";
  if (runBasename === SCORER_WORKFLOW) {
    throw new Error(
      `ci_dispatch refuses: run ${runId} on ${full} is a ${SCORER_WORKFLOW} run, and rerunning it re-executes the signing step against that run's ref. The loop dispatches its own scorer.`
    );
  }
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: "POST",
  });
  if (!resp.ok) {
    throw new Error(
      `ci_dispatch rerun failed for run ${runId} (${resp.status}): ${(await resp.text()).slice(0, 300) || "no response body"}`
    );
  }
  return { repo: full, mode: "rerun" as const, run_id: runId, rerun_requested: true };
}

// Dispatches the workflow on ref and polls until a new run for that ref appears or
// the timeout passes.
async function dispatchAndPoll(
  env: Env,
  namespace: string,
  full: string,
  args: { workflow: string; ref: string; inputs?: Record<string, string> },
  repoSelector: string | undefined,
  timing: { timeoutMs: number; intervalMs: number }
) {
  const { timeoutMs, intervalMs } = timing;
  // The runs that already exist for this ref, so the new one can be told apart. The
  // dispatch endpoint answers 204 with no body and names nothing it started.
  const before = new Set((await workflowRunsForBranch(env, namespace, args.ref, repoSelector)).map((r) => r.id));

  try {
    await dispatchWorkflow(env, namespace, args.workflow, args.inputs ?? {}, repoSelector, args.ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // GitHub answers 422 naming workflow_dispatch when the workflow file has no such
    // trigger. Saying so beats an opaque 422 the caller has to read the YAML for.
    if (/workflow_dispatch/i.test(message)) {
      throw new Error(
        `ci_dispatch refuses: ${args.workflow} has no workflow_dispatch trigger on ${full}, so it cannot be started by hand. Add "on: workflow_dispatch:" to that workflow, or trigger it the way it is configured. GitHub said: ${message.slice(0, 200)}`
      );
    }
    throw err;
  }

  // POLL, because 204 means accepted, not started. A caller with no run id has
  // nothing to watch, which is what this tool returns one for.
  const deadline = Date.now() + timeoutMs;
  let appeared: Awaited<ReturnType<typeof workflowRunsForBranch>>[number] | undefined;
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    polls += 1;
    appeared = (await workflowRunsForBranch(env, namespace, args.ref, repoSelector)).find((r) => !before.has(r.id));
    if (appeared) break;
  }

  if (!appeared) {
    return {
      repo: full,
      mode: "dispatch" as const,
      workflow: args.workflow,
      ref: args.ref,
      dispatched: true,
      run_id: null,
      polls,
      note: `dispatch was accepted, but no new run appeared for ${args.ref} within ${timeoutMs / 1000}s. It may still start; check ci_status with this ref. A dispatch that is accepted and never runs usually means the workflow's own conditions excluded it.`,
    };
  }
  return {
    repo: full,
    mode: "dispatch" as const,
    workflow: args.workflow,
    ref: args.ref,
    dispatched: true,
    run_id: appeared.id,
    status: appeared.status,
    url: appeared.url,
    polls,
  };
}

/** Trigger a workflow_dispatch, or rerun a run's failed jobs. dispatchWorkflow is
 *  the only dispatch path. */
export async function ciDispatch(
  env: Env,
  namespace: string,
  args: { workflow?: string; ref?: string; run_id?: number; inputs?: Record<string, string> },
  repoSelector?: string,
  // Injectable for tests only; the tool never passes it, so production uses the
  // constants above. Without it the timeout case costs 30 seconds in the suite.
  poll: { timeoutMs?: number; intervalMs?: number } = {}
) {
  const timeoutMs = poll.timeoutMs ?? CI_DISPATCH_POLL_MS;
  const intervalMs = poll.intervalMs ?? CI_DISPATCH_POLL_INTERVAL_MS;
  if (args.workflow !== undefined) refuseScorerByName(args.workflow);
  const target = await resolveRepo(env, namespace, repoSelector);
  if (args.workflow) await refuseScorerByContent(env, target, args.workflow, args.ref);

  if (args.run_id) {
    if (args.workflow) throw new Error("ci_dispatch: pass workflow and ref to start a run, or run_id to rerun one, not both");
    return rerunFailedJobs(env, target, args.run_id);
  }

  if (!args.workflow || !args.ref) throw new Error("ci_dispatch: workflow and ref are both required to start a run");
  return dispatchAndPoll(
    env,
    namespace,
    target.full,
    { workflow: args.workflow, ref: args.ref, inputs: args.inputs },
    repoSelector,
    { timeoutMs, intervalMs }
  );
}
