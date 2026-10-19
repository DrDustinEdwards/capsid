import type { Env } from "./env";
import { onRoster } from "./roster";
import { isMoneyPath } from "./scope";
import { POLICY_ID_ITEM, policyField, readSignedPolicy } from "./signed-docs";

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
// body names would let any open PR that named a finished job merge on green CI.
// The PR itself is judged too: head_in_base_repo refuses a fork head, job_handed_on
// refuses a job that is not blocked or done, and pr_recorded_for_job refuses a PR the
// holder never recorded against that job.
//
// pr_author_allowed refuses a PR whose GitHub author login is not on the allowlist the
// signed document carries. The list is in the document and not here, so changing who
// may author an unattended merge is a signed act.
//
// Version 7 (job_e68de044f8a4; Dustin, 2026-10-10, plan step 2) drops author_is_driver,
// which required the job to have been claimed by a minted driver agent. Cloud sessions
// sign in as the admin login and complete a job without a claim, naming its pull request
// (src/jobs-seat.ts completeUnclaimed), so nothing they opened could merge. Who may open
// an unattended merge stays pr_author_allowed's question, and pr_recorded_for_job still
// requires the pull request to be recorded against the job by whoever completed it. The
// same version adds size_within_cap: a pull request over AUTO_MERGE_SIZE_CAP changed lines
// waits for a person's approval.
export const POLICY_CHECKS = [
  "paths_not_refused",
  "paths_not_money",
  "no_migration_workflow_lockfile",
  "paths_allowed_for_namespace",
  "head_in_base_repo",
  "body_names_job",
  "pr_author_allowed",
  "job_handed_on",
  "pr_recorded_for_job",
  "base_is_default_branch",
  "size_within_cap",
  "ci_green",
] as const;

export type PolicyCheck = (typeof POLICY_CHECKS)[number];

// The most changed lines (additions plus deletions, as GitHub counts them) a pull request
// may carry and still merge with no human. Over it, the merge class is approve: one tap,
// with the reason "over the size cap". Ona caps its auto-approval at 1,000 lines, and
// Intercom's agent refuses large pull requests; a big diff is where a review earns its time.
export const AUTO_MERGE_SIZE_CAP = 1000;

/** Whether a pull request's changed lines are over the size cap. Uncounted is not over it;
 *  the policy refuses an uncounted pull request on its own. */
export const overSizeCap = (facts: Pick<PrFacts, "changedLines">): boolean => facts.changedLines !== null && facts.changedLines > AUTO_MERGE_SIZE_CAP;

/** The reason a pull request over the cap carries, in the merge class and the decline. */
export const sizeCapReason = (facts: Pick<PrFacts, "changedLines">): string =>
  `over the size cap: ${facts.changedLines} changed lines, more than ${AUTO_MERGE_SIZE_CAP}`;

// The paths auto-merge refuses, separate from PROTECTED_PATH_PATTERNS (what needs the
// can_touch_protected flag, src/protected-paths.ts). Tests, src/, docs, CLAUDE.md and .claude/ merge on green; these do
// not, because each changes what judges a change or what ships beside it. Matched
// case-insensitively against the repo-relative path; the document lists each source.
export const AUTO_MERGE_REFUSED_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/gate-policy\.ts$/i, why: "the gate policy source" },
  { pattern: /^src\/auto-merge(-(policy|tick))?\.ts$/i, why: "the auto-merge source, which holds this list" },
  { pattern: /^src\/policy-sign\.ts$/i, why: "the policy signer" },
  { pattern: /^src\/protected-paths\.ts$/i, why: "the protected path list" },
  // The sources the checks read their answers from, not only the ones that run them.
  // Each is a two-step route otherwise: a green driver PR weakens the source and
  // merges on its own, and the next PR passes the check it weakened.
  { pattern: /^src\/scope\.ts$/i, why: "isMoneyPath, which is the whole of the paths_not_money check" },
  { pattern: /^src\/signed-docs\.ts$/i, why: "verifySignedBody, which is how loadMergePolicy decides the stored policy is signed" },
  { pattern: /^src\/auth\.ts$/i, why: "the HMAC and the constant-time comparison that verifier delegates to" },
  { pattern: /^src\/encoding\.ts$/i, why: "the hex encoding of the signature that verifier compares" },
  { pattern: /^src\/github\/client\.ts$/i, why: "the reader that supplies the changed paths and the CI facts every check judges" },
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
  // Install, build and deploy glue. A namespace with no allowed-path limit merged these
  // on green, though each runs in CI or ships (Grok audit 2026-10, U2). Lockfiles are
  // no_migration_workflow_lockfile's, below.
  { pattern: /(^|\/)scripts\//i, why: "a script CI, a build or a deploy runs" },
  { pattern: /(^|\/)\.github\//i, why: "CI configuration beyond the workflows" },
  { pattern: /(^|\/)package\.json$/i, why: "a nested package manifest, whose scripts and dependencies an install runs" },
  { pattern: /(^|\/)(pnpm-workspace\.yaml|\.pnpmfile\.cjs|\.yarnrc[^/]*)$/i, why: "install configuration or a hook that runs during install" },
  { pattern: /(^|\/)\.npmrc$/i, why: "npm registry and install-script policy" },
  { pattern: /(^|\/)Dockerfile[^/]*$/i, why: "the image a build runs in" },
  { pattern: /(^|\/)Makefile$/i, why: "build glue CI executes" },
  { pattern: /(^|\/)\.husky\//i, why: "a git hook CI may run" },
  { pattern: /(^|\/)\.gitmodules$/i, why: "submodules the checkout would fetch and run" },
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

// The paths a namespace's pull requests may touch at all, for a namespace that carries
// a limit. Every changed path must match one of its patterns; a namespace with no entry
// here has no limit beyond the refused paths. capsid carries one (Dustin, D6 of
// 2026-10-03, policy version 6): a capsid merge deploys the control plane, so only
// docs outside docs/policy/ and the Portal's stylesheets merge unattended there, and
// tests, the Portal's scripts and every other path wait for the seat. This is the one
// path list that admits rather than refuses, so it is per namespace: inheriting another
// namespace's allow list would widen, not narrow. Matched case-insensitively, like the
// refused paths, so docs/Policy/ is still docs/policy/.
export const AUTO_MERGE_ALLOWED_PATHS: Record<string, Array<{ pattern: RegExp; why: string }>> = {
  capsid: [
    { pattern: /^docs\/(?!policy\/).+$/i, why: "a document under docs/, except the policy sources in docs/policy/" },
    { pattern: /^dashboard\/.+\.css$/i, why: "a Portal stylesheet" },
  ],
};

/** The allowed-path rule for a namespace, or null when it has no limit. */
function allowedPathsFor(namespace: string): Array<{ pattern: RegExp; why: string }> | null {
  return Object.hasOwn(AUTO_MERGE_ALLOWED_PATHS, namespace) ? AUTO_MERGE_ALLOWED_PATHS[namespace] : null;
}

/** Every allowed-path pattern as the document writes it, under its namespace's heading. */
export const namespacedAllowedPaths = (): string[] =>
  Object.entries(AUTO_MERGE_ALLOWED_PATHS).flatMap(([ns, rows]) => rows.map((r) => `${ns} / ${r.pattern.source}`));

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
  // One typecheck step runs all four configs.
  capsid: [
    "Typecheck src, tests, integration tests and the copied scorer script",
    "Lint dead exports and doc drift",
    "Tests",
    "Integration tests",
  ].map(ciStep("checks")),
  // Every named step of both jobs of dustinedwards-info's ci.yml, read off main on
  // 2026-10-18. Install and the build steps are named alongside the ones that judge, so
  // a reordered workflow that drops one refuses rather than merging on a run that
  // skipped it. The Admin MCP job's command steps carry no name, so GitHub reports them
  // as "Run <command>", and those are the names below.
  dustinedwards: [
    ...["Install", "Migrations, stack and content build, local sync", "Lint", "Gates", "Build"].map(ciStep("Gates, clean checkout")),
    ...[
      "Install",
      "Bootstrap wrangler.jsonc from the example",
      "Run npm run typecheck",
      "Run npm run check:wrapper",
      "Run npm run check:wrapper:plant",
      "Run npm test",
      "Run npm run build",
    ].map(ciStep("Admin MCP, clean checkout")),
  ],
  // Every step of Carrel's two jobs, read off its ci.yml on main on 2026-10-07. Carrel's
  // steps that run a command carry no name, so GitHub names them "Run <command>"; that
  // is the name the jobs API reports, and a script rename in package.json that changes
  // the command text refuses until this list is updated. Both jobs judge: `check` runs
  // the types, tests and accessibility scan, `gates` the conformance suite and the plants.
  carrel: [
    ...[
      "Run npm ci",
      "Run npm run typecheck",
      "Run npm test",
      "Run npm run check:postinstall",
      "Run npm run check:mcp-roles",
      "Install Chromium for the accessibility scan",
      "Run npm run check:a11y",
    ].map(ciStep("check")),
    ...["Run npm ci", "Run npm run check:conformance", "Run npm run check:plants"].map(ciStep("gates")),
  ],
  // Every blocking step of Capsomer's `check` job, read off its ci.yml on main on
  // 2026-10-07. The steps its own file marks warn-only (forced-colours screenshots, size,
  // token check, the site summary and the artifact upload) are left out: they run with
  // continue-on-error or always(), so a pass proves nothing about the change. The
  // `results` job runs on a push to main only and is skipped on a pull request. The
  // separate No bloat workflow is warn-only by its own ruling and is not required.
  capsomer: [
    "Install",
    "Palette, scales, unit tests, types",
    "Every family's contrast pairs, both themes (blocking, rule 18)",
    "Build the behaviour modules and wrappers",
    "Build the site and every states page",
    "Install Chromium",
    "Keyboard and accessibility tests, both themes",
  ].map(ciStep("check")),
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
  // Each entry is `<namespace> / <pattern>`, from the `## Allowed paths, <namespace>`
  // heading it was written under, compared with the code's list like the steps are.
  allowedPaths: string[];
  // GitHub logins whose PRs may merge without a human, from the document only.
  authors: string[];
  // The merge units promoted to auto (docs/design/design-merge-pipeline.md section 7,
  // PR 10), each `<namespace> / <path class>`, from the `## Auto units` section. Like the
  // author allowlist, the list lives only in the signed document; the code holds only the
  // path classes a unit may name (PROMOTABLE_PATH_CLASSES).
  units: string[];
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
const ALLOW_ITEM = /^- allow `([^`]+)`/;
const UNIT_ITEM = /^- unit `([^`]+)`/;
const UNITS_HEADING = /^##\s+Auto units\s*$/i;

// The path classes a unit may promote: every class src/merge-class.ts holds except
// money (typed forever, design section 8), migration and workflow (each a step outside a
// merge, class seat). test/auto-merge-units.test.ts holds this to merge-class's list.
export const PROMOTABLE_PATH_CLASSES: readonly string[] = ["docs", "dashboard-css", "tests", "dashboard-code", "deps-own", "src-routine", "deps-other", "src-worth"];
// The heading a required step is filed under: `## Required CI, <namespace>`. A step
// written before any such heading is a refusal rather than a step belonging to
// whichever namespace came first.
const CI_HEADING = /^##\s+Required CI,\s*([a-z0-9-]+)\s*$/i;
// The heading an allowed path is filed under: `## Allowed paths, <namespace>`. Same rule:
// an allowed path under no such heading is a refusal, never a limit on some namespace.
const ALLOW_HEADING = /^##\s+Allowed paths,\s*([a-z0-9-]+)\s*$/i;

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
      error: `the policy names ${unknown.join(", ")}, which is not on the roster. A policy cannot widen the set of repos this Worker reaches.`,
    };
  }
  const checks: string[] = [];
  const refusedPaths: string[] = [];
  const authors: string[] = [];
  const requiredCi: string[] = [];
  const allowedPaths: string[] = [];
  const units: string[] = [];
  let ciNamespace: string | null = null;
  let allowNamespace: string | null = null;
  let inUnits = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Any heading closes the section, so a step under `## What a merge means` is not
    // filed under the last namespace that appeared above it.
    if (trimmed.startsWith("##")) {
      const heading = CI_HEADING.exec(trimmed);
      ciNamespace = heading ? heading[1] : null;
      const allowHeading = ALLOW_HEADING.exec(trimmed);
      allowNamespace = allowHeading ? allowHeading[1] : null;
      inUnits = UNITS_HEADING.test(trimmed);
      continue;
    }
    const unitItem = UNIT_ITEM.exec(trimmed);
    if (unitItem) {
      // A unit is a widening, so every way it can be malformed refuses the whole document.
      if (!inUnits) return { error: `the policy lists unit '${unitItem[1]}' outside the ## Auto units section, so whether it is promoted is unstated.` };
      const m = /^([a-z0-9-]+)\s*\/\s*([a-z-]+)$/.exec(unitItem[1]!.trim());
      if (!m) return { error: `the policy's unit '${unitItem[1]}' is not '<namespace> / <path class>'.` };
      const [, ns, cls] = m;
      if (!PROMOTABLE_PATH_CLASSES.includes(cls!)) {
        return { error: `the policy's unit '${unitItem[1]}' names path class '${cls}', which is ${cls === "money" || cls === "migration" || cls === "workflow" ? "never promoted to auto" : "not a path class this Worker knows"}. Refusing the whole document rather than guessing what it widens.` };
      }
      if (!namespaces.includes(ns!)) return { error: `the policy's unit '${unitItem[1]}' names ${ns}, which the policy does not cover.` };
      const unit = `${ns} / ${cls}`;
      if (units.includes(unit)) return { error: `the policy lists unit '${unit}' twice.` };
      units.push(unit);
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
    const allow = ALLOW_ITEM.exec(trimmed);
    if (allow) {
      if (!allowNamespace) {
        return { error: `the policy lists allowed path '${allow[1]}' under no namespace heading, so which namespace it limits is unstated.` };
      }
      allowedPaths.push(`${allowNamespace} / ${allow[1]}`);
    }
  }
  // Fails closed: a document with no author allowlist loads nothing.
  if (authors.length === 0) {
    return { error: "the policy document names no PR author, so it authorises no pull request. Refusing rather than merging with no author allowlist." };
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", namespaces, checks, refusedPaths, allowedPaths, authors, requiredCi, units } };
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
  return checkMergePolicyBody(read.body);
}

/** Every check loadMergePolicy makes of a body once its signature is verified: it parses,
 *  and it says no less, and nothing different, than the code enforces. The one place a body
 *  is judged loadable, so a body signed from the repo (sign_policy_from_repo) is held to
 *  what the loader will hold it to. */
export function checkMergePolicyBody(body: string): { policy: MergePolicy } | { error: string } {
  const parsed = parseMergePolicy(body);
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
  // Both directions here too: a limit the document drops would widen a namespace the
  // signer meant to hold narrow, and one it adds would be a limit nothing enforces.
  const allowed = listDisagreement("allowed paths", parsed.policy.allowedPaths, namespacedAllowedPaths());
  if (allowed) return { error: allowed };
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
  // Additions plus deletions across the changed files, as GitHub counts them, or null
  // when a file came back without its counts, which size_within_cap refuses.
  changedLines: number | null;
  // The existing tests the pull request changes (src/github/pr-files.ts). No policy check
  // reads it: the class and the tick do, and hold such a pull request for Dustin.
  existingTestEdits: string[];
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
  // Resolved from the job id in the PR body. jobClaimedBy is who held or completed the
  // job, for the audit row; no check reads it.
  jobId: string | null;
  jobClaimedBy: string | null;
  jobStatus: string | null;
  // Every pull request URL the job's holder recorded: result_ref and the
  // job_outcome_prs rows, all written by the transitions that complete or block a job
  // (src/jobs-holder.ts) or seeded from what they wrote.
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

// The statuses in which a job has handed its PR on. A session opens the PR and then
// completes (done) or stops at a gate (blocked). A queued, claimed, failed or
// superseded job has not handed anything on, so its id in a PR body proves nothing,
// and a job id no row in this namespace carries has no status at all.
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
    pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/i,
    why: "a lockfile, which decides what gets installed and executed",
  },
];

/**
 * The whole policy, as a pure function of facts and the signed document's author
 * allowlist. Every check refuses on its own.
 */
export function evaluatePolicy(
  facts: PrFacts,
  allowedAuthors: string[],
  // The promoted unit this PR falls in, when the signed policy lists its namespace and
  // path class under ## Auto units (the tick computes the path class). It widens only
  // paths_allowed_for_namespace: never a refused path, money, a migration or a workflow.
  promoted: { unit: string } | null = null
): PolicyVerdict {
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

  // A namespace with a limit merges only a change whose every path is inside it. A PR
  // that changes no file shows nothing inside the limit, so it waits for the seat too.
  const allowedRules = allowedPathsFor(facts.namespace);
  if (allowedRules) {
    if (facts.changedPaths.length === 0) {
      return no("paths_allowed_for_namespace", `the PR changes no file, and ${facts.namespace} merges unattended only a change inside its allowed paths.`);
    }
    const outside = facts.changedPaths.filter((p) => !allowedRules.some(({ pattern }) => pattern.test(p)));
    if (outside.length > 0 && !promoted) {
      return no(
        "paths_allowed_for_namespace",
        `${facts.namespace} merges unattended only ${allowedRules.map((r) => r.why).join(" or ")}, and the change also touches ${outside.join(", ")}.`
      );
    }
  }
  passed.push("paths_allowed_for_namespace");

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

  if (!facts.jobStatus || !HANDED_ON_STATUSES.includes(facts.jobStatus)) {
    return no("job_handed_on", `${facts.jobId} is ${facts.jobStatus ?? "in no status"}, not blocked or done, so it has not handed a PR on.`);
  }
  passed.push("job_handed_on");

  // The PR itself must be recorded against the job, or anyone could name a finished
  // job in a PR body.
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

  if (facts.changedLines === null) {
    return no("size_within_cap", "GitHub reported no line counts for at least one changed file, so the size cap cannot be judged. A person approves it.");
  }
  if (overSizeCap(facts)) return no("size_within_cap", `${sizeCapReason(facts)}. A person approves it.`);
  passed.push("size_within_cap");

  const ci = ciGreenOn(facts);
  if (ci.state !== "green") return no("ci_green", ci.why);
  passed.push("ci_green");

  return { merge: true, passed };
}

/** The ci_green check on the facts' head sha, with the same required steps the policy
 *  reads, shared by the policy and the approval executor (docs/design/design-merge-pipeline.md
 *  section 4: "through the same function and the same required steps as the policy").
 *  green: every check and every required step succeeded. wait: CI has not finished, or its
 *  steps could not be read. red: CI failed, or a required step did not run to success.
 *  never: no required steps are written down for the namespace, so no run shows anything. */
export function ciGreenOn(facts: Pick<PrFacts, "headSha" | "ciConclusion" | "ciNote" | "ciStepsProblem" | "ciSteps" | "namespace">): { state: "green" | "wait" | "red" | "never"; why: string } {
  const sha = facts.headSha.slice(0, 7);
  if (facts.ciConclusion === null || facts.ciConclusion === "pending") return { state: "wait", why: `CI on ${sha} is ${facts.ciConclusion ?? "not reported"}: ${facts.ciNote}` };
  if (facts.ciConclusion !== "success") return { state: "red", why: `CI on ${sha} is ${facts.ciConclusion}: ${facts.ciNote}` };
  if (facts.ciStepsProblem) {
    return { state: "wait", why: `the CI steps on ${sha} could not be read (${facts.ciStepsProblem}), so the required suites are not shown to have run.` };
  }
  const required = requiredCiFor(facts.namespace);
  if (!required) {
    return { state: "never", why: `no required CI steps are written down for namespace '${facts.namespace}', so a green run there shows nothing. It waits for the seat.` };
  }
  const notRun = required.filter(
    (r) => !facts.ciSteps.some((s) => s.workflow === r.workflow && s.job === r.job && s.step === r.step && s.conclusion === "success")
  );
  if (notRun.length > 0) return { state: "red", why: `CI on ${sha} did not run ${notRun.map(requiredCiLabel).join(", ")} to success.` };
  return { state: "green", why: `CI on ${sha} is green, with every required step` };
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
