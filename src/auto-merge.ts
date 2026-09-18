import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { managePr } from "./github/refs";
import { improveAudit } from "./improve-state";
import { onRoster } from "./improve-schema";
import { isMoneyPath } from "./scope";
import { verifySignedBody } from "./improve-task";

// ---- the policy document ------------------------------------------------------
//
// WHAT THE WORKER MAY MERGE WITHOUT A HUMAN, and where that list lives. The document
// is capsid/policy/auto-merge.md, signed with the same key and envelope as a task
// document, because it decides whether this Worker may write to a default branch
// that deploys on push. An unsigned or edited policy merges nothing.
//
// THE DOCUMENT NAMES THE CHECKS AND THE CODE ENFORCES THEM. A policy document the
// Worker parsed into predicates would be a configuration language, and a change to it
// would be a code change nobody reviewed as one. So the document carries the version,
// whether the policy is enabled, and which namespaces it covers, and it names every
// check by id, every refused path pattern and every required CI step. The code holds
// the same three lists. test/auto-merge.test.ts asserts the two agree in both directions, so a
// check added in code and not written down fails the build, and loadMergePolicy
// refuses at run time as well, because the test proves the pair in the repo and the
// document actually lives in the database.
export const AUTO_MERGE_POLICY_PATH = "policy/auto-merge.md";
const POLICY_NAMESPACE = "capsid";

// Every check, in the order evaluated. Each one refuses on its own. The three path
// checks run first because they are the never-list: a change to one of those paths
// is not merged without a human, whatever the rest of the PR looks like.
export const POLICY_CHECKS = [
  "paths_not_refused",
  "paths_not_money",
  "no_migration_workflow_lockfile",
  "body_names_job",
  "author_is_driver",
  "base_is_default_branch",
  "ci_green",
] as const;

export type PolicyCheck = (typeof POLICY_CHECKS)[number];

// THE PATHS AUTO-MERGE REFUSES (policy version 2, ruled 2026-09-17). Separate from
// PROTECTED_PATH_PATTERNS, which is what the improve loop may edit and is unchanged.
// Tests, src/, docs, CLAUDE.md and .claude/ merge on green; these do not, because
// each one changes what judges a change, or what ships beside it. Every pattern is
// matched case-insensitively against the repo-relative path. The policy document
// lists each pattern source, and loadMergePolicy refuses a document whose list
// differs from this one in either direction.
export const AUTO_MERGE_REFUSED_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^\.github\/workflows\/improve-score\.yml$/i, why: "the scorer workflow" },
  { pattern: /^scripts\/improve-report\.mjs$/i, why: "the score report script" },
  { pattern: /^scripts\/sync-scorer\.mjs$/i, why: "the script that copies the scorer to the roster" },
  { pattern: /(^|\/)improve\/holdout\//i, why: "the holdout suite manifest" },
  { pattern: /^src\/improve-scorer\.ts$/i, why: "the only source that reads the holdout suite" },
  { pattern: /^test\/[^/]*holdout[^/]*$/i, why: "a test that keeps the holdout suite away from attempt code" },
  { pattern: /^src\/gate-policy\.ts$/i, why: "the gate policy source" },
  { pattern: /^src\/auto-merge\.ts$/i, why: "the auto-merge source, which holds this list" },
  { pattern: /^src\/policy-sign\.ts$/i, why: "the policy signer" },
  { pattern: /^src\/improve-schema\.ts$/i, why: "the protected path list" },
  // ADDED IN VERSION 3. Version 2 refused the sources that run the checks but not the
  // sources those checks read their answers from. Each of these is a two-step route: a
  // green driver PR weakens the source and merges on its own, and the next PR then
  // passes the check it weakened. src/scope.ts and src/improve-task.ts were found by
  // the seat reviewing PR #70; the other three are what those two delegate to and what
  // supplies the facts they judge.
  { pattern: /^src\/scope\.ts$/i, why: "isMoneyPath, which is the whole of the paths_not_money check" },
  { pattern: /^src\/improve-task\.ts$/i, why: "verifySignedBody, which is how loadMergePolicy decides the stored policy is signed" },
  { pattern: /^src\/auth\.ts$/i, why: "the HMAC and the constant-time comparison that verifier delegates to" },
  { pattern: /^src\/encoding\.ts$/i, why: "the hex encoding of the signature that verifier compares" },
  { pattern: /^src\/github\/client\.ts$/i, why: "the reader that supplies the changed paths and the CI facts every check judges" },
  { pattern: /^scripts\/path-guard\.mjs$/i, why: "the driver's enforcement of the protected path list" },
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)wrangler\.(jsonc?|toml)(\.example)?$/i, why: "deployment configuration" },
  { pattern: /(^|\/)\.dev\.vars/i, why: "a secrets file" },
  { pattern: /(^|\/)\.env($|\.)/i, why: "a secrets file" },
  { pattern: /^package\.json$/i, why: "the npm scripts CI runs as the checks" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, why: "what the typechecks check" },
  { pattern: /(^|\/)vitest\.config\.[cm]?[jt]s$/i, why: "the integration suite's configuration" },
  { pattern: /^scripts\/test-budget\.mjs$/i, why: "the runner behind npm test" },
  { pattern: /^scripts\/verify-live\.mjs$/i, why: "the live gate, whose rollback is the backstop for an unattended merge" },
];

function refusedPathHits(paths: string[]): Array<{ path: string; why: string }> {
  const hits: Array<{ path: string; why: string }> = [];
  for (const path of paths) {
    const rule = AUTO_MERGE_REFUSED_PATHS.find(({ pattern }) => pattern.test(path));
    if (rule) hits.push({ path, why: rule.why });
  }
  return hits;
}

// THE CI STEPS A GREEN PR MUST HAVE RUN. The CI workflow runs all four typechecks and
// both suites as steps of one job, so check-run names cannot show that any of them
// ran. ci_green reads the steps of the newest run of this workflow on the head sha,
// and each one named here must have concluded success. A skipped step is not a pass.
export const AUTO_MERGE_REQUIRED_CI: Array<{ workflow: string; job: string; step: string }> = [
  "Typecheck",
  "Typecheck tests",
  "Typecheck integration tests",
  "Typecheck the copied scorer script",
  "Tests",
  "Integration tests",
].map((step) => ({ workflow: ".github/workflows/ci.yml", job: "checks", step }));

export const requiredCiLabel = (r: { workflow: string; job: string; step: string }): string =>
  `${r.workflow} / ${r.job} / ${r.step}`;

export interface MergePolicy {
  version: string;
  enabled: boolean;
  namespaces: string[];
  checks: string[];
  refusedPaths: string[];
  requiredCi: string[];
}

function field(body: string, name: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`- ${name}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

// A check id as the document writes it: a backticked lowercase name at the head of a
// list item. Matching the backticks rather than any list item keeps the prose around
// the list from being read as policy.
const CHECK_ITEM = /^- `([a-z_]+)`/;
// A refused path and a required CI step, written as `- path `<source>`` and
// `- step `<workflow> / <job> / <step>``. The leading word keeps them from being
// read as check ids.
const PATH_ITEM = /^- path `([^`]+)`/;
const STEP_ITEM = /^- step `([^`]+)`/;

/** Parse the policy body below its frontmatter. Returns the policy or a refusal. */
export function parseMergePolicy(body: string): { policy: MergePolicy } | { error: string } {
  const version = field(body, "version");
  if (!version) {
    return { error: "the policy document names no version. A merge audited against an unnamed policy cannot be traced to what it allowed." };
  }
  const enabled = field(body, "enabled");
  if (enabled === null) return { error: "the policy document does not say whether it is enabled." };
  const namespaces = (field(body, "namespaces") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (namespaces.length === 0) return { error: "the policy document covers no namespaces, so it authorises nothing." };
  const unknown = namespaces.filter((n) => !onRoster(n));
  if (unknown.length > 0) {
    return {
      error: `the policy names ${unknown.join(", ")}, which is not on the improve roster. A policy cannot widen the set of repos this Worker reaches.`,
    };
  }
  const checks: string[] = [];
  const refusedPaths: string[] = [];
  const requiredCi: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    const check = CHECK_ITEM.exec(trimmed);
    if (check) checks.push(check[1]);
    const path = PATH_ITEM.exec(trimmed);
    if (path) refusedPaths.push(path[1]);
    const step = STEP_ITEM.exec(trimmed);
    if (step) requiredCi.push(step[1]);
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", namespaces, checks, refusedPaths, requiredCi } };
}

// Both directions: what the document lists and the code does not, and the reverse.
function listDisagreement(what: string, documented: string[], enforced: string[]): string | null {
  const unenforced = documented.filter((d) => !enforced.includes(d));
  const undocumented = enforced.filter((e) => !documented.includes(e));
  if (unenforced.length === 0 && undocumented.length === 0) return null;
  const parts: string[] = [];
  if (undocumented.length > 0) parts.push(`does not list ${undocumented.join(", ")}, which this Worker enforces`);
  if (unenforced.length > 0) parts.push(`lists ${unenforced.join(", ")}, which this Worker does not enforce`);
  return `the policy document's ${what} ${parts.join(", and ")}. Refusing rather than merging against a policy that disagrees with the code.`;
}

/** Read and verify the policy. A missing, unsigned or tampered document merges nothing. */
export async function loadMergePolicy(env: Env): Promise<{ policy: MergePolicy } | { error: string }> {
  const row = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_NAMESPACE, AUTO_MERGE_POLICY_PATH)
    .first<{ body: string | null }>();
  if (!row) return { error: `no merge policy at ${POLICY_NAMESPACE}/${AUTO_MERGE_POLICY_PATH}, so nothing is auto-merged.` };
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, row.body ?? "", "merge policy");
  if (!verdict.ok) return { error: verdict.reason };
  const parsed = parseMergePolicy(row.body ?? "");
  if ("error" in parsed) return parsed;
  const missing = POLICY_CHECKS.filter((c) => !parsed.policy.checks.includes(c));
  if (missing.length > 0) {
    return {
      error: `the policy document does not name ${missing.join(", ")}, which this Worker enforces. Refusing rather than merging against a policy that describes less than the code does.`,
    };
  }
  const paths = listDisagreement(
    "refused paths",
    parsed.policy.refusedPaths,
    AUTO_MERGE_REFUSED_PATHS.map((p) => p.pattern.source)
  );
  if (paths) return { error: paths };
  const steps = listDisagreement("required CI steps", parsed.policy.requiredCi, AUTO_MERGE_REQUIRED_CI.map(requiredCiLabel));
  if (steps) return { error: steps };
  return parsed;
}

// ---- evaluating one pull request ----------------------------------------------

export interface PrFacts {
  number: number;
  repo: string;
  namespace: string;
  baseRef: string;
  defaultBranch: string;
  headSha: string;
  body: string;
  changedPaths: string[];
  // Why the changed-file list is incomplete, or null when it was read whole. An
  // incomplete list refuses at the first path check, before any path is judged.
  filesProblem: string | null;
  // null when no check run has reported, which is NOT green.
  ciConclusion: string | null;
  ciNote: string;
  // The steps of the newest run of each workflow on the head sha, and why they could
  // not be read, or null.
  ciSteps: Array<{ workflow: string; job: string; step: string; conclusion: string | null }>;
  ciStepsProblem: string | null;
  // Resolved from the job id in the PR body.
  jobId: string | null;
  jobClaimedBy: string | null;
  driverAgent: { name: string; kind: string; revoked: boolean } | null;
}

export type PolicyVerdict =
  | { merge: true; passed: PolicyCheck[] }
  | { merge: false; failed: PolicyCheck; why: string; passed: PolicyCheck[] };

// The job id a driver puts in a PR body. Matched anywhere in the body so the prose
// around it is free.
const JOB_ID_IN_BODY = /\bjob_[0-9a-f]{12}\b/;

export function jobIdFromBody(body: string): string | null {
  return JOB_ID_IN_BODY.exec(body ?? "")?.[0] ?? null;
}

// Named separately from the refused list because their consequence is not local: a
// migration runs against the live database, a workflow is what measures the code, and
// a lockfile decides what gets installed and executed. The refused list also covers
// migrations and the scorer workflow; this is the second statement for those, so
// removing a pattern from one list does not quietly open the other.
const MIGRATION_WORKFLOW_LOCKFILE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)\.github\/workflows\//i, why: "a workflow, which is what measures the code" },
  {
    pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|deno\.lock)$/i,
    why: "a lockfile, which decides what gets installed and executed",
  },
];

/** The whole policy, as a pure function of facts. Every check refuses on its own. */
export function evaluatePolicy(facts: PrFacts): PolicyVerdict {
  const passed: PolicyCheck[] = [];
  const no = (failed: PolicyCheck, why: string): PolicyVerdict => ({ merge: false, failed, why, passed: [...passed] });

  // A path list that was not read whole is not judged on the part that loaded: a
  // refused path on page two is how that would merge.
  if (facts.filesProblem) {
    return no("paths_not_refused", `the changed-file list is incomplete (${facts.filesProblem}), so this PR is not evaluated.`);
  }
  const refused = refusedPathHits(facts.changedPaths);
  if (refused.length > 0) {
    return no("paths_not_refused", `the change touches ${refused.length} path(s) auto-merge refuses: ${refused.map((h) => `${h.path} (${h.why})`).join("; ")}.`);
  }
  passed.push("paths_not_refused");

  const money = facts.changedPaths.filter((p) => isMoneyPath(p));
  if (money.length > 0) {
    return no("paths_not_money", `the change touches a billing or payment surface: ${money.join(", ")}.`);
  }
  passed.push("paths_not_money");

  for (const path of facts.changedPaths) {
    for (const { pattern, why } of MIGRATION_WORKFLOW_LOCKFILE) {
      if (pattern.test(path)) return no("no_migration_workflow_lockfile", `${path} is ${why}.`);
    }
  }
  passed.push("no_migration_workflow_lockfile");

  if (!facts.jobId) {
    return no("body_names_job", "the PR body names no job id, so there is no request this change can be traced back to.");
  }
  passed.push("body_names_job");

  if (!facts.jobClaimedBy) {
    return no("author_is_driver", `the PR body names ${facts.jobId}, but no such job is recorded in this namespace.`);
  }
  if (!facts.driverAgent) {
    return no("author_is_driver", `${facts.jobId} was held by ${facts.jobClaimedBy}, which is not a minted agent. Only a driver agent's work auto-merges.`);
  }
  if (facts.driverAgent.kind !== "driver") {
    return no("author_is_driver", `${facts.driverAgent.name} is kind '${facts.driverAgent.kind}', not a driver.`);
  }
  if (facts.driverAgent.revoked) {
    return no("author_is_driver", `${facts.driverAgent.name} has been revoked, so its open work waits for the seat.`);
  }
  passed.push("author_is_driver");

  if (facts.baseRef !== facts.defaultBranch) {
    return no("base_is_default_branch", `the PR targets '${facts.baseRef}', not the default branch '${facts.defaultBranch}'.`);
  }
  passed.push("base_is_default_branch");

  const sha = facts.headSha.slice(0, 7);
  if (facts.ciConclusion !== "success") {
    return no("ci_green", `CI on ${sha} is ${facts.ciConclusion ?? "not reported"}: ${facts.ciNote}`);
  }
  if (facts.ciStepsProblem) {
    return no("ci_green", `the CI steps on ${sha} could not be read (${facts.ciStepsProblem}), so the required suites are not shown to have run.`);
  }
  const notRun = AUTO_MERGE_REQUIRED_CI.filter(
    (r) => !facts.ciSteps.some((s) => s.workflow === r.workflow && s.job === r.job && s.step === r.step && s.conclusion === "success")
  );
  if (notRun.length > 0) {
    return no("ci_green", `CI on ${sha} did not run ${notRun.map(requiredCiLabel).join(", ")} to success.`);
  }
  passed.push("ci_green");

  return { merge: true, passed };
}

// ---- gathering the facts ------------------------------------------------------

interface OpenPr {
  number: number;
  body: string | null;
  base: { ref: string };
  head: { sha: string };
}

// Every completed check run must have concluded success, skipped or neutral, and at
// least one must have reported. A PR with no checks is NOT green: it is a PR whose
// workflow never started, which is indistinguishable from one whose workflow was
// removed.
export function ciVerdict(
  runs: Array<{ name: string; status: string; conclusion: string | null }>
): { conclusion: string | null; note: string } {
  if (runs.length === 0) return { conclusion: null, note: "no check run has reported on this commit" };
  const pending = runs.filter((r) => r.status !== "completed");
  if (pending.length > 0) {
    return { conclusion: "pending", note: `${pending.length} check(s) still running: ${pending.map((r) => r.name).join(", ")}` };
  }
  const bad = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
  if (bad.length > 0) {
    return { conclusion: "failure", note: `${bad.map((r) => `${r.name}=${r.conclusion ?? "null"}`).join(", ")}` };
  }
  return { conclusion: "success", note: `${runs.length} check(s) green` };
}

// ---- reading a paged GitHub list to the end ----------------------------------------
//
// AUDIT-2026-09-16: the tick read the first 100 files and the first 100 check runs of
// a PR and judged it on those. Every page is read now, and a list that could not be
// read whole is reported rather than judged. The cost is bounded: GitHub serves at most
// FILES_LIMIT files for a pull request, which is FILES_MAX_PAGES pages at PER_PAGE, and
// check runs stop at CHECKS_MAX_PAGES. A PR under 100 of each costs the same two reads
// as before.
//
// THE NEXT PAGE IS REQUESTED BY NUMBER on the repo's own path. The Link header is read
// only to learn that another page exists, so its URL never reaches ghFetch, whose
// bounds check accepts only /repos/<owner>/<repo>/ paths.
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

// The steps of the newest run of each required workflow on this sha. Only workflows
// AUTO_MERGE_REQUIRED_CI names are read, so an unrelated workflow costs nothing. The
// run list is filtered by head_sha, which for a pull_request run is the PR head.
async function ciStepsFor(
  env: Env,
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
  for (const workflow of new Set(AUTO_MERGE_REQUIRED_CI.map((r) => r.workflow))) {
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
  let driverAgent: PrFacts["driverAgent"] = null;
  if (jobId) {
    const job = await env.DB.prepare("SELECT claimed_by FROM jobs WHERE id = ?1 AND namespace = ?2")
      .bind(jobId, namespace)
      .first<{ claimed_by: string | null }>();
    jobClaimedBy = job?.claimed_by ?? null;
    if (jobClaimedBy?.startsWith("agent:")) {
      const name = jobClaimedBy.slice("agent:".length);
      const row = await env.DB.prepare("SELECT name, kind, revoked_at FROM agents WHERE name = ?1")
        .bind(name)
        .first<{ name: string; kind: string; revoked_at: string | null }>();
      if (row) driverAgent = { name: row.name, kind: row.kind, revoked: row.revoked_at !== null };
    }
  }

  const [files, checks] = await Promise.all([
    readAllPages<{ filename: string }>(
      env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}/files`, (page) => page as Array<{ filename: string }>, FILES_MAX_PAGES
    ),
    readAllPages<{ name: string; status: string; conclusion: string | null }>(
      env, owner, repo, `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
      (page) => (page as { check_runs: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs,
      CHECKS_MAX_PAGES
    ),
  ]);
  // A GitHub file list stops at FILES_LIMIT with no next page, so a list that reached
  // it may have been cut by GitHub rather than by this reader.
  const filesProblem = files.problem ?? (files.items.length >= FILES_LIMIT ? `GitHub lists at most ${FILES_LIMIT} files for a pull request and this one reached that` : null);
  const changedPaths = files.items.map((f) => f.filename);
  // A read that failed or was cut short is not a pass. paths_not_refused refuses an
  // incomplete file list and ci_green an incomplete check-run list, each with the
  // reason, so the seat decides it. Judging a PR on the pages that did load is how a
  // protected path on page two was merged.
  const ci = checks.problem
    ? { conclusion: null, note: `the check-run list is incomplete (${checks.problem}), so this PR is not evaluated` }
    : ciVerdict(checks.items);
  const steps = await ciStepsFor(env, owner, repo, pr.head.sha);

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
    jobId,
    jobClaimedBy,
    driverAgent,
  };
}

// ---- what the audit row says --------------------------------------------------
//
// Built by a pure function rather than inline at the call site, so what lands in
// audit_log is asserted directly by test/auto-merge.test.ts. An audit row nobody
// checks is a record whose shape drifts silently.

export function declineParams(
  policyVersion: string,
  facts: PrFacts,
  verdict: Extract<PolicyVerdict, { merge: false }>,
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

// ---- the tick step ------------------------------------------------------------

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

// WHERE THE AWAITING-SEAT SET LIVES. Rewritten whole on every tick rather than
// appended to, because the tick recomputes the full set of open pull requests each
// time: a PR that a human merged or closed simply stops appearing, with no second
// mechanism needed to expire it. improve_status reads this key rather than calling
// GitHub, so asking for status costs nothing.
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
    try {
      ({ owner, repo } = await resolveRepo(env, namespace));
    } catch (err) {
      console.error(`AUTO_MERGE could not resolve ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const defaultBranch = await getDefaultBranch(env, owner, repo);
    const listed = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
    if (!listed.ok) {
      console.error(`AUTO_MERGE could not list PRs on ${owner}/${repo} (${listed.status})`);
      continue;
    }
    const prs = (await listed.json()) as OpenPr[];

    for (const pr of prs) {
      const facts = await factsForPr(env, namespace, owner, repo, defaultBranch, pr);
      const verdict = evaluatePolicy(facts);
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
          improveAudit(env.DB, "auto-merge-declined", namespace, declineParams(policy.version, facts, verdict, now)),
        ]);
        continue;
      }
      // merge_method "merge" because the policy audits a head sha and a squash would
      // not preserve it on the default branch.
      const result = await managePr(env, namespace, pr.number, "merge", "merge");
      outcomes.push({ namespace, repo: facts.repo, number: pr.number, merged: true, failed: null, why: null, passed: verdict.passed });
      await env.DB.batch([
        improveAudit(
          env.DB,
          "auto-merged",
          namespace,
          mergeParams(policy.version, facts, verdict.passed, (result as { sha?: string }).sha ?? null, now)
        ),
      ]);
    }
  }

  // The full awaiting-seat set, written whole. Written even when it is empty, so a
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
    // A status surface that could not be written does not fail the merges that
    // already happened.
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
