import type { Env } from "./env";
import { onRoster } from "./improve-schema";
import { isMoneyPath } from "./scope";
import { POLICY_ID_ITEM, policyField, readSignedPolicy } from "./improve-task";

// What the Worker may merge without a human, and where that list lives. The document
// is capsid/policy/auto-merge.md, signed with the same key and envelope as a task
// document, because it decides whether this Worker may write to a default branch that
// deploys on push. An unsigned or edited policy merges nothing.
//
// The document names the checks and the code enforces them. A policy document parsed
// into predicates would be a configuration language, and a change to it would be a
// code change nobody reviewed as one. So the document carries the version, whether the
// policy is enabled and which namespaces it covers, and it names every check by id,
// every refused path pattern and every required CI step. The code holds the same three
// lists. test/auto-merge.test.ts asserts the two agree in both directions, and
// loadMergePolicy refuses at run time as well, because the test proves the pair in the
// repo while the document lives in the database.
//
// One list lives only in the document: the PR author allowlist. The code has no copy
// to compare it with, so it is a value the signature governs, and a document without
// one does not load.
export const AUTO_MERGE_POLICY_PATH = "policy/auto-merge.md";

// Every check, in the order evaluated. Each one refuses on its own. The three path
// checks run first because they are the never list: a change to one of those paths is
// not merged without a human, whatever the rest of the PR looks like.
//
// Job ids are public, in commit subjects and PR bodies, so judging only the job a PR
// body names would let any open PR that named a finished driver job merge on green CI.
// The PR itself is judged too: head_in_base_repo refuses a fork head, job_handed_on
// refuses a job that is not blocked or done, and pr_recorded_for_job refuses a PR the
// driver never recorded against that job.
//
// pr_author_allowed refuses a PR whose GitHub author login is not on the allowlist the
// signed document carries. The list is in the document and not here, so changing who
// may author an unattended merge is a signed act.
export const POLICY_CHECKS = [
  "paths_not_refused",
  "paths_not_money",
  "no_migration_workflow_lockfile",
  "head_in_base_repo",
  "body_names_job",
  "pr_author_allowed",
  "author_is_driver",
  "job_handed_on",
  "pr_recorded_for_job",
  "base_is_default_branch",
  "ci_green",
] as const;

export type PolicyCheck = (typeof POLICY_CHECKS)[number];

// The paths auto-merge refuses, separate from PROTECTED_PATH_PATTERNS (what the improve
// loop may edit). Tests, src/, docs, CLAUDE.md and .claude/ merge on green; these do
// not, because each changes what judges a change or what ships beside it. Matched
// case-insensitively against the repo-relative path; the document lists each source.
export const AUTO_MERGE_REFUSED_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^\.github\/workflows\/improve-score\.yml$/i, why: "the scorer workflow" },
  { pattern: /^scripts\/improve-report\.mjs$/i, why: "the score report script" },
  { pattern: /^scripts\/sync-scorer\.mjs$/i, why: "the script that copies the scorer to the roster" },
  { pattern: /(^|\/)improve\/holdout\//i, why: "the holdout suite manifest" },
  { pattern: /^src\/improve-scorer\.ts$/i, why: "the only source that reads the holdout suite" },
  { pattern: /^test\/[^/]*holdout[^/]*$/i, why: "a test that keeps the holdout suite away from attempt code" },
  { pattern: /^src\/gate-policy\.ts$/i, why: "the gate policy source" },
  { pattern: /^src\/auto-merge(-(policy|tick))?\.ts$/i, why: "the auto-merge source, which holds this list" },
  { pattern: /^src\/policy-sign\.ts$/i, why: "the policy signer" },
  { pattern: /^src\/improve-schema\.ts$/i, why: "the protected path list" },
  // The sources the checks read their answers from, not only the ones that run them.
  // Each is a two-step route otherwise: a green driver PR weakens the source and
  // merges on its own, and the next PR passes the check it weakened.
  { pattern: /^src\/scope\.ts$/i, why: "isMoneyPath, which is the whole of the paths_not_money check" },
  { pattern: /^src\/improve-task\.ts$/i, why: "verifySignedBody, which is how loadMergePolicy decides the stored policy is signed" },
  { pattern: /^src\/auth\.ts$/i, why: "the HMAC and the constant-time comparison that verifier delegates to" },
  { pattern: /^src\/encoding\.ts$/i, why: "the hex encoding of the signature that verifier compares" },
  { pattern: /^src\/github\/client\.ts$/i, why: "the reader that supplies the changed paths and the CI facts every check judges" },
  { pattern: /^scripts\/path-guard\.mjs$/i, why: "the driver's enforcement of the protected path list" },
  // dustinedwards-info's judge files. The list stays one list rather than one per
  // namespace: every pattern is a refusal, so a namespace inheriting another's pattern
  // can only refuse more, and a list split per namespace would be a second place to
  // forget a pattern.
  { pattern: /^\.github\/workflows\//i, why: "any workflow, which is what CI runs" },
  { pattern: /^scripts\/check-[^/]*\.mjs$/i, why: "a check script, which is what the Gates step runs" },
  { pattern: /^scripts\/lib\//i, why: "the library those check scripts read their rules from" },
  { pattern: /(^|\/)\.aislop\//i, why: "the slop checker's word lists and allowances" },
  { pattern: /(^|\/)workers\//i, why: "a worker that ships beside the site" },
  { pattern: /(^|\/)package-lock\.json$/i, why: "the lockfile CI installs from" },
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)wrangler\.(jsonc?|toml)(\.example)?$/i, why: "deployment configuration" },
  { pattern: /(^|\/)\.dev\.vars/i, why: "a secrets file" },
  { pattern: /(^|\/)\.env($|\.)/i, why: "a secrets file" },
  { pattern: /^package\.json$/i, why: "the npm scripts CI runs as the checks" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, why: "what the typechecks check" },
  { pattern: /(^|\/)vitest\.config\.[cm]?[jt]s$/i, why: "the integration suite's configuration" },
  { pattern: /^scripts\/test-budget\.mjs$/i, why: "the runner behind npm test" },
  { pattern: /^scripts\/verify-live\.mjs$/i, why: "the live gate, whose rollback is the backstop for an unattended merge" },
  // pr_recorded_for_job trusts result_ref and job_outcome_prs because only the job's
  // holder writes them. These two sources are what writes them, so a green PR that
  // loosened either could record any PR against any job. The job transitions are
  // src/jobs.ts and the jobs-* modules it re-exports; jobs-schema.ts writes nothing.
  { pattern: /^src\/jobs(-(claim|holder|seat|mirror|transition))?\.ts$/i, why: "the job transitions that write result_ref, which pr_recorded_for_job reads" },
  { pattern: /^src\/outcome-prs\.ts$/i, why: "the writer of job_outcome_prs, which pr_recorded_for_job reads" },
];

function refusedPathHits(paths: string[]): Array<{ path: string; why: string }> {
  const hits: Array<{ path: string; why: string }> = [];
  for (const path of paths) {
    const rule = AUTO_MERGE_REFUSED_PATHS.find(({ pattern }) => pattern.test(path));
    if (rule) hits.push({ path, why: rule.why });
  }
  return hits;
}

// The CI steps a green PR must have run, per namespace. A repo's CI runs its suites as
// steps of one job, so check-run names cannot show that any of them ran. ci_green reads
// the steps of the newest run of each named workflow on the head sha, and every step
// named for that namespace must have concluded success. A skipped step is not a pass.
//
// Per namespace because the step names belong to the repo, not to this policy.
// Checking one repo's step names against another repo's workflow would refuse every
// pull request there. A namespace with no list here merges nothing, which is the same
// refusal for a namespace whose CI nobody has written down.
export interface RequiredStep {
  workflow: string;
  job: string;
  step: string;
}

const ciStep = (job: string) => (step: string): RequiredStep => ({ workflow: ".github/workflows/ci.yml", job, step });

export const AUTO_MERGE_REQUIRED_CI: Record<string, RequiredStep[]> = {
  // One typecheck step runs all four configs. Version 5 of the policy does not cover
  // capsid, so this list is held for the load-time agreement check only.
  capsid: [
    "Typecheck src, tests, integration tests and the copied scorer script",
    "Lint dead exports and doc drift",
    "Tests",
    "Integration tests",
  ].map(ciStep("checks")),
  // Every step of dustinedwards-info's one job. Install and the build step are named
  // alongside the three that judge, so a reordered workflow that drops one refuses
  // rather than merging on a run that skipped it.
  dustinedwards: [
    "Install",
    "Migrations, stack and content build, publication twins, enhancement bundles, local sync",
    "Lint",
    "Slop",
    "Gates",
  ].map(ciStep("Gates, clean checkout")),
};

/** The steps that namespace's pull requests must have run, or null when none are written down. */
export function requiredCiFor(namespace: string): RequiredStep[] | null {
  const rows = Object.hasOwn(AUTO_MERGE_REQUIRED_CI, namespace) ? AUTO_MERGE_REQUIRED_CI[namespace] : undefined;
  return rows && rows.length > 0 ? rows : null;
}

export const requiredCiLabel = (r: RequiredStep): string => `${r.workflow} / ${r.job} / ${r.step}`;

/** Every required step as the document writes it, under its namespace's heading. */
export const namespacedCiLabels = (): string[] =>
  Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) => rows.map((r) => `${ns} / ${requiredCiLabel(r)}`));

export interface MergePolicy {
  version: string;
  enabled: boolean;
  namespaces: string[];
  checks: string[];
  refusedPaths: string[];
  // GitHub logins whose PRs may merge without a human, from the document only.
  authors: string[];
  // Each entry is `<namespace> / <workflow> / <job> / <step>`, built from the heading
  // the step was written under. One flat list keeps the load-time agreement check a
  // single comparison in both directions, so a namespace section missing from the
  // document is caught by the same line that catches a missing step.
  requiredCi: string[];
}

// Check ids are read with POLICY_ID_ITEM. Paths, steps and authors carry a leading
// word so they are not read as check ids.
const PATH_ITEM = /^- path `([^`]+)`/;
const STEP_ITEM = /^- step `([^`]+)`/;
const AUTHOR_ITEM = /^- author `([^`]+)`/;
// The heading a required step is filed under: `## Required CI, <namespace>`. A step
// written before any such heading is a refusal rather than a step belonging to
// whichever namespace came first.
const CI_HEADING = /^##\s+Required CI,\s*([a-z0-9-]+)\s*$/i;

/** Parse the policy body below its frontmatter. Returns the policy or a refusal. */
export function parseMergePolicy(body: string): { policy: MergePolicy } | { error: string } {
  const version = policyField(body, "version");
  if (!version) {
    return { error: "the policy document names no version. A merge audited against an unnamed policy cannot be traced to what it allowed." };
  }
  const enabled = policyField(body, "enabled");
  if (enabled === null) return { error: "the policy document does not say whether it is enabled." };
  const namespaces = (policyField(body, "namespaces") ?? "")
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
  const authors: string[] = [];
  const requiredCi: string[] = [];
  let ciNamespace: string | null = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Any heading closes the section, so a step under `## What a merge means` is not
    // filed under the last namespace that appeared above it.
    if (trimmed.startsWith("##")) {
      const heading = CI_HEADING.exec(trimmed);
      ciNamespace = heading ? heading[1] : null;
      continue;
    }
    const check = POLICY_ID_ITEM.exec(trimmed);
    if (check) checks.push(check[1]);
    const path = PATH_ITEM.exec(trimmed);
    if (path) refusedPaths.push(path[1]);
    const author = AUTHOR_ITEM.exec(trimmed);
    if (author) authors.push(author[1]);
    const step = STEP_ITEM.exec(trimmed);
    if (step) {
      if (!ciNamespace) {
        return { error: `the policy lists required CI step '${step[1]}' under no namespace heading, so which repo's CI it describes is unstated.` };
      }
      requiredCi.push(`${ciNamespace} / ${step[1]}`);
    }
  }
  // Fails closed: a document with no author allowlist loads nothing.
  if (authors.length === 0) {
    return { error: "the policy document names no PR author, so it authorises no pull request. Refusing rather than merging with no author allowlist." };
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", namespaces, checks, refusedPaths, authors, requiredCi } };
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
  const read = await readSignedPolicy(env, AUTO_MERGE_POLICY_PATH, "merge policy", "nothing is auto-merged");
  if ("error" in read) return read;
  const parsed = parseMergePolicy(read.body);
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
  const steps = listDisagreement("required CI steps", parsed.policy.requiredCi, namespacedCiLabels());
  if (steps) return { error: steps };
  // A namespace the policy covers with no required CI steps merges nothing. Without
  // this, ci_green's step check would have nothing to compare and would pass on any run
  // that reported at all, so a widening here would be quiet rather than fail closed.
  const uncovered = parsed.policy.namespaces.filter((n) => requiredCiFor(n) === null);
  if (uncovered.length > 0) {
    return {
      error: `the policy covers ${uncovered.join(", ")}, for which this Worker holds no required CI steps. A green run there would prove nothing, so it is refused rather than merged.`,
    };
  }
  return parsed;
}

export interface PrFacts {
  number: number;
  repo: string;
  namespace: string;
  baseRef: string;
  defaultBranch: string;
  headSha: string;
  body: string;
  changedPaths: string[];
  // Why the changed-file list is incomplete, or null. An incomplete list refuses.
  filesProblem: string | null;
  // null when no check run has reported, which is NOT green.
  ciConclusion: string | null;
  ciNote: string;
  // The steps of the newest run of each workflow on the head sha, and why they could
  // not be read, or null.
  ciSteps: Array<{ workflow: string; job: string; step: string; conclusion: string | null }>;
  ciStepsProblem: string | null;
  // The owner/name of the repo the PR's head branch lives on, as GitHub reports it, or
  // null when GitHub reports none (a fork that was deleted).
  headRepo: string | null;
  // The login of the GitHub account that opened the PR (pr.user.login), or null when
  // GitHub reports none.
  prAuthor: string | null;
  // Resolved from the job id in the PR body.
  jobId: string | null;
  jobClaimedBy: string | null;
  jobStatus: string | null;
  driverAgent: { name: string; kind: string; revoked: boolean } | null;
  // Every pull request URL the job's holder recorded: result_ref and the
  // job_outcome_prs rows, all written by transitions keyed on claimed_by or seeded
  // from what they wrote.
  jobPrUrls: string[];
}

export type PolicyVerdict =
  | { merge: true; passed: PolicyCheck[] }
  | { merge: false; failed: PolicyCheck; why: string; passed: PolicyCheck[] };

// The job id a driver puts in a PR body, matched anywhere in it.
const JOB_ID_IN_BODY = /\bjob_[0-9a-f]{12}\b/;

export function jobIdFromBody(body: string): string | null {
  return JOB_ID_IN_BODY.exec(body ?? "")?.[0] ?? null;
}

// The statuses in which a job has handed its PR on. A driver opens the PR and then
// completes (done) or stops at a gate (blocked). A queued, claimed, failed or
// superseded job has not handed anything on, so its id in a PR body proves nothing.
const HANDED_ON_STATUSES = ["blocked", "done"];

// A PR URL as the job records hold it, compared case-insensitively. The match ends at
// the PR number, so pull/23 never matches pull/234.
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/g;

function normalizedPrUrls(text: string | null): string[] {
  return [...(text ?? "").matchAll(PR_URL)].map((m) => m[0].toLowerCase());
}

// Named separately from the refused list because their consequence is not local: a
// migration runs against the live database, a workflow is what measures the code, and
// a lockfile decides what gets installed and executed. The refused list also covers
// some of these; this is the second statement for them, so removing a pattern from
// one list does not quietly open the other.
const MIGRATION_WORKFLOW_LOCKFILE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)\.github\/workflows\//i, why: "a workflow, which is what measures the code" },
  {
    pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|deno\.lock)$/i,
    why: "a lockfile, which decides what gets installed and executed",
  },
];

/**
 * The whole policy, as a pure function of facts and the signed document's author
 * allowlist. Every check refuses on its own.
 */
export function evaluatePolicy(facts: PrFacts, allowedAuthors: string[]): PolicyVerdict {
  const passed: PolicyCheck[] = [];
  const no = (failed: PolicyCheck, why: string): PolicyVerdict => ({ merge: false, failed, why, passed: [...passed] });

  // A path list that was not read whole is not judged on the part that loaded: a
  // refused path on page two would merge that way.
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

  // A fork's head is code nobody holding a credential here pushed. GitHub reports no
  // head repo when the fork was deleted, which is refused the same way.
  if (!facts.headRepo || facts.headRepo.toLowerCase() !== facts.repo.toLowerCase()) {
    return no("head_in_base_repo", `the PR's head is on ${facts.headRepo ?? "no repo GitHub reports"}, not on ${facts.repo}. A fork's PR waits for the seat.`);
  }
  passed.push("head_in_base_repo");

  if (!facts.jobId) {
    return no("body_names_job", "the PR body names no job id, so there is no request this change can be traced back to.");
  }
  passed.push("body_names_job");

  // Case-insensitive, as GitHub treats logins. An empty allowlist matches nobody.
  const author = facts.prAuthor?.toLowerCase() ?? null;
  if (!author || !allowedAuthors.some((a) => a.toLowerCase() === author)) {
    return no(
      "pr_author_allowed",
      `the PR was opened by ${facts.prAuthor ?? "no account GitHub reports"}, which is not on the policy's author allowlist (${allowedAuthors.join(", ") || "empty"}).`
    );
  }
  passed.push("pr_author_allowed");

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

  if (!facts.jobStatus || !HANDED_ON_STATUSES.includes(facts.jobStatus)) {
    return no("job_handed_on", `${facts.jobId} is ${facts.jobStatus ?? "in no status"}, not blocked or done, so it has not handed a PR on.`);
  }
  passed.push("job_handed_on");

  // The PR itself must be recorded against the job, or anyone could name a finished
  // driver job in a PR body.
  const url = `https://github.com/${facts.repo}/pull/${facts.number}`.toLowerCase();
  if (!facts.jobPrUrls.some((recorded) => normalizedPrUrls(recorded).includes(url))) {
    return no(
      "pr_recorded_for_job",
      `${facts.jobId}'s holder never recorded this PR against it (neither its result_ref nor its outcome PRs name ${url}), so it is not shown to be that job's work.`
    );
  }
  passed.push("pr_recorded_for_job");

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
  const required = requiredCiFor(facts.namespace);
  if (!required) {
    return no("ci_green", `no required CI steps are written down for namespace '${facts.namespace}', so a green run there shows nothing. It waits for the seat.`);
  }
  const notRun = required.filter(
    (r) => !facts.ciSteps.some((s) => s.workflow === r.workflow && s.job === r.job && s.step === r.step && s.conclusion === "success")
  );
  if (notRun.length > 0) {
    return no("ci_green", `CI on ${sha} did not run ${notRun.map(requiredCiLabel).join(", ")} to success.`);
  }
  passed.push("ci_green");

  return { merge: true, passed };
}

// Every completed check run must have concluded success, skipped or neutral, and at
// least one must have reported. A PR with no checks is not green: its workflow never
// started, which cannot be told apart from a workflow that was removed.
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
