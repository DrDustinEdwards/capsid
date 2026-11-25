import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { PER_PAGE, readCheckRuns, readPrFiles } from "./github/pr-files";
import { requiredCiFor } from "./auto-merge-policy";
import { type PrFacts, jobIdFromBody, ciVerdict } from "./auto-merge-policy-evaluate";

export interface OpenPr {
  number: number;
  title?: string | null;
  body: string | null;
  labels?: Array<{ name?: string }> | null;
  base: { ref: string };
  // repo is null when the head was on a fork that has since been deleted.
  head: { sha: string; repo?: { full_name?: string } | null };
  user?: { login?: string } | null;
  draft?: boolean;
}

const CHECKS_MAX_PAGES = 10;

interface WorkflowRun {
  id: number;
  path: string;
}

async function ciStepsFor(
  env: Env,
  namespace: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<{ steps: PrFacts["ciSteps"]; problem: string | null }> {
  const runsResp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=${PER_PAGE}`,
  );
  if (!runsResp.ok)
    return { steps: [], problem: `the workflow run list returned ${runsResp.status}` };
  const runs = ((await runsResp.json()) as { workflow_runs?: WorkflowRun[] }).workflow_runs ?? [];
  const steps: PrFacts["ciSteps"] = [];
  for (const workflow of new Set((requiredCiFor(namespace) ?? []).map((r) => r.workflow))) {
    const newest = runs.filter((r) => r.path === workflow).sort((a, b) => b.id - a.id)[0];
    if (!newest) continue;
    const jobsResp = await ghFetch(
      env,
      owner,
      repo,
      `/repos/${owner}/${repo}/actions/runs/${newest.id}/jobs?per_page=${PER_PAGE}`,
    );
    if (!jobsResp.ok)
      return { steps: [], problem: `the jobs of run ${newest.id} returned ${jobsResp.status}` };
    const jobs =
      (
        (await jobsResp.json()) as {
          jobs?: Array<{
            name: string;
            steps?: Array<{ name: string; conclusion: string | null }>;
          }>;
        }
      ).jobs ?? [];
    for (const job of jobs) {
      for (const step of job.steps ?? []) {
        steps.push({ workflow, job: job.name, step: step.name, conclusion: step.conclusion });
      }
    }
  }
  return { steps, problem: null };
}

export async function factsForPr(
  env: Env,
  namespace: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  pr: OpenPr,
): Promise<PrFacts> {
  const body = pr.body ?? "";
  const jobId = jobIdFromBody(body);

  let jobClaimedBy: string | null = null;
  let jobStatus: string | null = null;
  const jobPrUrls: string[] = [];
  if (jobId) {
    const job = await env.DB.prepare(
      "SELECT claimed_by, status, result_ref FROM jobs WHERE id = ?1 AND namespace = ?2",
    )
      .bind(jobId, namespace)
      .first<{ claimed_by: string | null; status: string | null; result_ref: string | null }>();
    jobClaimedBy = job?.claimed_by ?? null;
    jobStatus = job?.status ?? null;
    if (job) {
      if (job.result_ref) jobPrUrls.push(job.result_ref);
      const recorded = await env.DB.prepare("SELECT pr_url FROM job_outcome_prs WHERE job_id = ?1")
        .bind(jobId)
        .all<{ pr_url: string }>();
      jobPrUrls.push(...(recorded.results ?? []).map((r) => r.pr_url));
    }
  }

  const [files, checks] = await Promise.all([
    readPrFiles(env, owner, repo, pr.number),
    readCheckRuns(env, owner, repo, pr.head.sha, CHECKS_MAX_PAGES),
  ]);
  const filesProblem = files.problem;
  const changedPaths = files.paths;
  const ci = checks.problem
    ? {
        conclusion: null,
        note: `the check-run list is incomplete (${checks.problem}), so this PR is not evaluated`,
      }
    : ciVerdict(checks.items);
  const steps = await ciStepsFor(env, namespace, owner, repo, pr.head.sha);

  return {
    number: pr.number,
    repo: `${owner}/${repo}`,
    namespace,
    baseRef: pr.base.ref,
    defaultBranch,
    headSha: pr.head.sha,
    body,
    changedPaths,
    filesProblem,
    changedLines: files.changedLines,
    existingTestEdits: files.testEdits,
    ciConclusion: ci.conclusion,
    ciNote: ci.note,
    ciSteps: steps.steps,
    ciStepsProblem: steps.problem,
    headRepo: pr.head.repo?.full_name ?? null,
    prAuthor: pr.user?.login ?? null,
    jobId,
    jobClaimedBy,
    jobStatus,
    jobPrUrls,
  };
}

const OPEN_PR_PAGES = 10;

export async function listOpenPrs(
  env: Env,
  owner: string,
  repo: string,
): Promise<OpenPr[] | string> {
  const all: OpenPr[] = [];
  for (let page = 1; page <= OPEN_PR_PAGES; page++) {
    const listed = await ghFetch(
      env,
      owner,
      repo,
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!listed.ok) return String(listed.status);
    const batch = (await listed.json()) as OpenPr[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  return `more than ${OPEN_PR_PAGES * 100} open PRs`;
}
