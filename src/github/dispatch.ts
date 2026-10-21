import type { RepoEnv as Env } from "../env";
import { assertRepoArg, resolveRepo, getDefaultBranch, ghFetch } from "./client";

// ci_dispatch (src/github/actions.ts reads CI): fire a workflow or rerun failed jobs,
// then poll for the run it started.

// Fire a workflow_dispatch. workflow_dispatch runs the workflow file as it exists at
// `ref`, so a caller that passes no override dispatches against the default branch.
//
// `refOverride` exists for ci_dispatch, where a human asking for a branch means that
// branch.
async function dispatchWorkflow(
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
async function workflowRunsForBranch(
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

export const CI_DISPATCH_POLL_MS = 30_000;
export const CI_DISPATCH_POLL_INTERVAL_MS = 3_000;

// A workflow is a YAML file in .github/workflows. GitHub's dispatch endpoint also
// accepts a numeric id or a full path; this tool takes the file name only.
function refuseUnnamedWorkflow(workflow: string): void {
  const basename = workflow.split("/").pop() ?? "";
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(basename)) {
    throw new Error(`ci_dispatch refuses: '${workflow}' is not a workflow file name. Pass the file name (for example ci.yml).`);
  }
}

async function rerunFailedJobs(env: Env, target: { owner: string; repo: string; full: string }, runId: number) {
  const { owner, repo, full } = target;
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
      note: `dispatch was accepted, but no new run appeared for ${args.ref} within ${timeoutMs / 1000}s. It may still start; check capsid_inspect_repo action ci with this ref. A dispatch that is accepted and never runs usually means the workflow's own conditions excluded it.`,
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
  if (args.workflow !== undefined) refuseUnnamedWorkflow(args.workflow);
  const target = await resolveRepo(env, namespace, repoSelector);

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
