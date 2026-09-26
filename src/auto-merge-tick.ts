import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { HeadMovedError, managePr } from "./github/refs";
import { improveAudit } from "./improve-state";
import {
  type PolicyCheck,
  requiredCiFor,
  loadMergePolicy,
  type PrFacts,
  jobIdFromBody,
  evaluatePolicy,
  ciVerdict,
} from "./auto-merge-policy";

// The auto-merge tick: read each open pull request's facts from GitHub and D1, judge
// them with evaluatePolicy (src/auto-merge-policy.ts), and merge or record the refusal.

interface OpenPr {
  number: number;
  body: string | null;
  base: { ref: string };
  // repo is null when the head was on a fork that has since been deleted.
  head: { sha: string; repo?: { full_name?: string } | null };
  user?: { login?: string } | null;
}

// Paged GitHub lists are read to the end, and a list not read whole is reported rather
// than judged. Bounded: GitHub serves at most FILES_LIMIT files for a pull request,
// and check runs stop at CHECKS_MAX_PAGES. The next page is requested by number; the
// Link header only says one exists, so its URL never reaches ghFetch.
const PER_PAGE = 100;
export const FILES_LIMIT = 3000;
const FILES_MAX_PAGES = FILES_LIMIT / PER_PAGE;
const CHECKS_MAX_PAGES = 10;

async function readAllPages<T>(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  rowsOf: (body: unknown) => T[],
  maxPages: number
): Promise<{ items: T[]; problem: string | null }> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await ghFetch(env, owner, repo, `${path}?per_page=${PER_PAGE}&page=${page}`);
    if (!resp.ok) return { items, problem: `page ${page} returned ${resp.status}` };
    items.push(...(rowsOf(await resp.json()) ?? []));
    if (!/rel="next"/.test(resp.headers.get("Link") ?? "")) return { items, problem: null };
  }
  return { items, problem: `more than ${maxPages} pages` };
}

interface WorkflowRun {
  id: number;
  path: string;
}

// The steps of the newest run of each required workflow on this head sha. Only
// workflows this namespace's required steps name are read.
async function ciStepsFor(
  env: Env,
  namespace: string,
  owner: string,
  repo: string,
  headSha: string
): Promise<{ steps: PrFacts["ciSteps"]; problem: string | null }> {
  const runsResp = await ghFetch(
    env, owner, repo, `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=${PER_PAGE}`
  );
  if (!runsResp.ok) return { steps: [], problem: `the workflow run list returned ${runsResp.status}` };
  const runs = ((await runsResp.json()) as { workflow_runs?: WorkflowRun[] }).workflow_runs ?? [];
  const steps: PrFacts["ciSteps"] = [];
  for (const workflow of new Set((requiredCiFor(namespace) ?? []).map((r) => r.workflow))) {
    const newest = runs.filter((r) => r.path === workflow).sort((a, b) => b.id - a.id)[0];
    // No run of a required workflow leaves its steps absent, which ci_green names.
    if (!newest) continue;
    const jobsResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/actions/runs/${newest.id}/jobs?per_page=${PER_PAGE}`);
    if (!jobsResp.ok) return { steps: [], problem: `the jobs of run ${newest.id} returned ${jobsResp.status}` };
    const jobs = ((await jobsResp.json()) as {
      jobs?: Array<{ name: string; steps?: Array<{ name: string; conclusion: string | null }> }>;
    }).jobs ?? [];
    for (const job of jobs) {
      for (const step of job.steps ?? []) {
        steps.push({ workflow, job: job.name, step: step.name, conclusion: step.conclusion });
      }
    }
  }
  return { steps, problem: null };
}

async function factsForPr(
  env: Env,
  namespace: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  pr: OpenPr
): Promise<PrFacts> {
  const body = pr.body ?? "";
  const jobId = jobIdFromBody(body);

  let jobClaimedBy: string | null = null;
  let jobStatus: string | null = null;
  let driverAgent: PrFacts["driverAgent"] = null;
  const jobPrUrls: string[] = [];
  if (jobId) {
    const job = await env.DB.prepare("SELECT claimed_by, status, result_ref FROM jobs WHERE id = ?1 AND namespace = ?2")
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
    if (jobClaimedBy?.startsWith("agent:")) {
      const name = jobClaimedBy.slice("agent:".length);
      const row = await env.DB.prepare("SELECT name, kind, revoked_at FROM agents WHERE name = ?1")
        .bind(name)
        .first<{ name: string; kind: string; revoked_at: string | null }>();
      if (row) driverAgent = { name: row.name, kind: row.kind, revoked: row.revoked_at !== null };
    }
  }

  const [files, checks] = await Promise.all([
    readAllPages<{ filename: string; previous_filename?: string }>(
      env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}/files`,
      (page) => page as Array<{ filename: string; previous_filename?: string }>, FILES_MAX_PAGES
    ),
    readAllPages<{ name: string; status: string; conclusion: string | null }>(
      env, owner, repo, `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
      (page) => (page as { check_runs: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs,
      CHECKS_MAX_PAGES
    ),
  ]);
  // A list that reached FILES_LIMIT may have been cut by GitHub with no next page.
  const filesProblem = files.problem ?? (files.items.length >= FILES_LIMIT ? `GitHub lists at most ${FILES_LIMIT} files for a pull request and this one reached that` : null);
  // A rename is judged under both names, so moving a refused file is refused.
  const changedPaths = files.items.flatMap((f) => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]));
  // An incomplete check-run list is not a pass; ci_green refuses it with the reason.
  const ci = checks.problem
    ? { conclusion: null, note: `the check-run list is incomplete (${checks.problem}), so this PR is not evaluated` }
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
    ciConclusion: ci.conclusion,
    ciNote: ci.note,
    ciSteps: steps.steps,
    ciStepsProblem: steps.problem,
    headRepo: pr.head.repo?.full_name ?? null,
    prAuthor: pr.user?.login ?? null,
    jobId,
    jobClaimedBy,
    jobStatus,
    driverAgent,
    jobPrUrls,
  };
}

// The audit row shapes, built by pure functions so test/auto-merge.test.ts asserts them.

export function declineParams(
  policyVersion: string,
  // Only the PR and head, so a PR declined before its facts were read is audited alike.
  facts: Pick<PrFacts, "repo" | "number" | "headSha">,
  // A policy refusal, or "head_moved" when GitHub refused the pinned merge.
  verdict: { failed: PolicyCheck | "head_moved"; why: string; passed: PolicyCheck[] },
  now: Date
): Record<string, unknown> {
  return {
    policy_version: policyVersion,
    repo: facts.repo,
    pr: facts.number,
    head_sha: facts.headSha,
    failed: verdict.failed,
    why: verdict.why,
    passed: verdict.passed,
    at: now.toISOString(),
  };
}

export function mergeParams(
  policyVersion: string,
  facts: PrFacts,
  passed: PolicyCheck[],
  mergeSha: string | null,
  now: Date
): Record<string, unknown> {
  return {
    policy_version: policyVersion,
    repo: facts.repo,
    pr: facts.number,
    head_sha: facts.headSha,
    job: facts.jobId,
    driver: facts.jobClaimedBy,
    merge_sha: mergeSha,
    passed,
    at: now.toISOString(),
  };
}

export interface AutoMergeOutcome {
  namespace: string;
  repo: string;
  number: number;
  merged: boolean;
  // The check that refused, for a PR left open.
  failed: string | null;
  why: string | null;
  passed: string[];
}

// Where the awaiting-seat set lives. Rewritten whole on every tick rather than
// appended to, because the tick recomputes the full set of open pull requests each
// time: a PR a human merged or closed stops appearing, with no second mechanism needed
// to expire it. improve_status reads this key rather than calling GitHub, so asking
// for status costs nothing.
export const AWAITING_SEAT_KEY = "improve:awaiting-seat";

export interface AwaitingSeat {
  namespace: string;
  repo: string;
  number: number;
  failed: string;
  why: string;
  at: string;
}

export interface AutoMergeReport {
  ran: boolean;
  note: string;
  policy_version: string | null;
  outcomes: AutoMergeOutcome[];
}

/** One pass over every open PR on every namespace the policy covers. */
export async function autoMergeTick(env: Env, now: Date): Promise<AutoMergeReport> {
  const loaded = await loadMergePolicy(env);
  if ("error" in loaded) return { ran: false, note: loaded.error, policy_version: null, outcomes: [] };
  const policy = loaded.policy;
  if (!policy.enabled) {
    return { ran: false, note: `merge policy ${policy.version} is present and disabled, so nothing is auto-merged.`, policy_version: policy.version, outcomes: [] };
  }

  const outcomes: AutoMergeOutcome[] = [];

  for (const namespace of policy.namespaces) {
    let owner: string;
    let repo: string;
    let defaultBranch: string;
    let prs: OpenPr[];
    // A namespace that cannot be read is skipped, not the whole tick. The default-branch
    // read and the list parse throw on a GitHub failure, and a throw here would stop
    // every later namespace and the awaiting-seat write.
    try {
      ({ owner, repo } = await resolveRepo(env, namespace));
      defaultBranch = await getDefaultBranch(env, owner, repo);
      const listed = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
      if (!listed.ok) {
        console.error(`AUTO_MERGE could not list PRs on ${owner}/${repo} (${listed.status})`);
        continue;
      }
      prs = (await listed.json()) as OpenPr[];
    } catch (err) {
      console.error(`AUTO_MERGE could not read ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const pr of prs) {
      // A PR whose body names no job is declined before any GitHub read, since
      // body_names_job refuses it anyway and the reads share the rate limit.
      if (!jobIdFromBody(pr.body ?? "")) {
        const skipped = {
          failed: "body_names_job" as const,
          why: "the PR body names no job id, so there is no request this change can be traced back to. Its files and checks were not read.",
          passed: [] as PolicyCheck[],
        };
        outcomes.push({ namespace, repo: `${owner}/${repo}`, number: pr.number, merged: false, ...skipped });
        try {
          await env.DB.batch([
            improveAudit(env.DB, "auto-merge-declined", namespace, declineParams(policy.version, { repo: `${owner}/${repo}`, number: pr.number, headSha: pr.head.sha }, skipped, now)),
          ]);
        } catch (err) {
          console.error(`AUTO_MERGE could not audit the decline of ${owner}/${repo}#${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      // One PR that throws does not end the tick. A 405 on a PR that is not mergeable,
      // a failed read or a D1 error would otherwise abort every later PR and namespace,
      // leave no audit row, and skip the awaiting-seat write. The PR is reported as not
      // merged with the error, and an auto-merge-failed row says why.
      const before = outcomes.length;
      try {
        await judgeOnePr(env, policy.version, policy.authors, namespace, owner, repo, defaultBranch, pr, outcomes, now);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`AUTO_MERGE failed on ${owner}/${repo}#${pr.number}: ${why}`);
        // An outcome already pushed is the true one; only its audit row failed.
        if (outcomes.length > before) continue;
        outcomes.push({ namespace, repo: `${owner}/${repo}`, number: pr.number, merged: false, failed: "error", why: `the tick could not judge or merge this PR: ${why}`, passed: [] });
        try {
          await env.DB.batch([
            improveAudit(env.DB, "auto-merge-failed", namespace, {
              policy_version: policy.version,
              repo: `${owner}/${repo}`,
              pr: pr.number,
              head_sha: pr.head.sha,
              error: why,
              at: now.toISOString(),
            }),
          ]);
        } catch (auditErr) {
          console.error(`AUTO_MERGE could not audit the failure on ${owner}/${repo}#${pr.number}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
        }
      }
    }
  }

  // The full awaiting-seat set, written whole, and written even when it is empty, so a
  // tick that cleared the last one leaves no stale entry behind.
  const awaiting: AwaitingSeat[] = outcomes
    .filter((o) => !o.merged)
    .map((o) => ({
      namespace: o.namespace,
      repo: o.repo,
      number: o.number,
      failed: o.failed ?? "unknown",
      why: o.why ?? "",
      at: now.toISOString(),
    }));
  try {
    await env.APP_KV.put(AWAITING_SEAT_KEY, JSON.stringify(awaiting));
  } catch (err) {
    console.error(`AUTO_MERGE could not record the awaiting-seat set: ${err instanceof Error ? err.message : String(err)}`);
  }

  const merged = outcomes.filter((o) => o.merged).length;
  return {
    ran: true,
    note: `policy ${policy.version}: ${merged} merged, ${outcomes.length - merged} left for the seat`,
    policy_version: policy.version,
    outcomes,
  };
}

/** Judge one PR that names a job, merge it when the policy passes, and audit either way.
 *  Pushes exactly one outcome, before its audit row, so a caller can tell a PR that was
 *  judged from one that threw first. */
async function judgeOnePr(
  env: Env,
  policyVersion: string,
  allowedAuthors: string[],
  namespace: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  pr: OpenPr,
  outcomes: AutoMergeOutcome[],
  now: Date
): Promise<void> {
  const facts = await factsForPr(env, namespace, owner, repo, defaultBranch, pr);
  const verdict = evaluatePolicy(facts, allowedAuthors);
  if (!verdict.merge) {
    outcomes.push({
      namespace,
      repo: facts.repo,
      number: pr.number,
      merged: false,
      failed: verdict.failed,
      why: verdict.why,
      passed: verdict.passed,
    });
    await env.DB.batch([
      improveAudit(env.DB, "auto-merge-declined", namespace, declineParams(policyVersion, facts, verdict, now)),
    ]);
    return;
  }
  // merge_method "merge", because a squash would not keep the audited head sha. Pinned
  // to the sha the checks read: a push since then gets a 409 and the next tick judges
  // the new head.
  let result: unknown;
  try {
    result = await managePr(env, namespace, pr.number, "merge", "merge", undefined, undefined, facts.headSha);
  } catch (err) {
    if (!(err instanceof HeadMovedError)) throw err;
    const moved = {
      failed: "head_moved" as const,
      why: `the PR head moved after the policy judged ${facts.headSha}, so GitHub refused the pinned merge. ${err.message}`,
      passed: verdict.passed,
    };
    outcomes.push({ namespace, repo: facts.repo, number: pr.number, merged: false, ...moved });
    await env.DB.batch([
      improveAudit(env.DB, "auto-merge-declined", namespace, declineParams(policyVersion, facts, moved, now)),
    ]);
    return;
  }
  outcomes.push({ namespace, repo: facts.repo, number: pr.number, merged: true, failed: null, why: null, passed: verdict.passed });
  await env.DB.batch([
    improveAudit(
      env.DB,
      "auto-merged",
      namespace,
      mergeParams(policyVersion, facts, verdict.passed, (result as { sha?: string }).sha ?? null, now)
    ),
  ]);
}
