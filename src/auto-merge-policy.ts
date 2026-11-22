import type { Env } from "./env";
import type { PrFacts } from "./auto-merge-policy-evaluate";
import { parseMergePolicy, type MergePolicy } from "./auto-merge-policy-parse";
import { readSignedPolicy } from "./signed-docs";

// What the Worker may merge without a human, and where that list lives: the document
// capsid/policy/auto-merge.md, signed like a task document, because it decides whether this
// Worker may write to a default branch that deploys on push. An unsigned or edited policy
// merges nothing.
//
// The document names the checks and the code enforces them (a document parsed into
// predicates would be a configuration language nobody reviews as code). The document carries
// the version, the enabled flag, the namespaces, and every check id, refused path pattern and
// required CI step; the code holds the same three lists. test/auto-merge.test.ts asserts they
// agree both ways, and loadMergePolicy refuses at run time too, because the document lives in
// the database. The PR author allowlist lives only in the document, so a document without one
// does not load.
export const AUTO_MERGE_POLICY_PATH = "policy/auto-merge.md";

// Every check, in the order evaluated, each refusing on its own. The three path checks run
// first: they are the never list.
//
// Job ids are public (commit subjects, PR bodies), so judging only the job a PR names would
// let any PR naming a finished job merge on green CI. The PR itself is judged too:
// head_in_base_repo refuses a fork head, job_handed_on a job not blocked or done, and
// pr_recorded_for_job a PR the holder never recorded against that job.
//
// pr_author_allowed refuses an author login not on the signed document's allowlist, so
// changing who may author an unattended merge is a signed act.
//
// Version 7 dropped author_is_driver: cloud sessions sign in as the admin login and complete
// a job without a claim (src/jobs-seat.ts completeUnclaimed), so nothing they opened could
// merge. pr_recorded_for_job still ties the PR to the job. It added size_within_cap: a PR over
// AUTO_MERGE_SIZE_CAP changed lines waits for a person.
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
// reason "over the size cap". A big diff is where a review earns its time.
export const AUTO_MERGE_SIZE_CAP = 1000;

/** Whether a pull request's changed lines are over the size cap. Uncounted is not over it;
 *  the policy refuses an uncounted pull request on its own. */
export const overSizeCap = (facts: Pick<PrFacts, "changedLines">): boolean =>
  facts.changedLines !== null && facts.changedLines > AUTO_MERGE_SIZE_CAP;

/** The reason a pull request over the cap carries, in the merge class and the decline. */
export const sizeCapReason = (facts: Pick<PrFacts, "changedLines">): string =>
  `over the size cap: ${facts.changedLines} changed lines, more than ${AUTO_MERGE_SIZE_CAP}`;

// The paths auto-merge refuses. Tests, src/, docs, CLAUDE.md and .claude/ merge on green; these do
// not, because each changes what judges a change or what ships beside it. Matched
// case-insensitively against the repo-relative path; the document lists each source.
export const AUTO_MERGE_REFUSED_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/gate-policy\.ts$/i, why: "the gate policy source" },
  {
    pattern: /^src\/auto-merge(-[a-z]+)*\.ts$/i,
    why: "the auto-merge source, which holds this list",
  },
  { pattern: /^src\/policy-sign(-[a-z]+)*\.ts$/i, why: "the policy signer" },
  { pattern: /^src\/protected-paths\.ts$/i, why: "the protected path list" },
  // The sources the checks read their answers from, not only the ones that run them.
  // Each is a two-step route otherwise: a green driver PR weakens the source and
  // merges on its own, and the next PR passes the check it weakened.
  {
    pattern: /^src\/scope(-[a-z]+)*\.ts$/i,
    why: "isMoneyPath, which is the whole of the paths_not_money check",
  },
  {
    pattern: /^src\/signed-docs\.ts$/i,
    why: "verifySignedBody, which is how loadMergePolicy decides the stored policy is signed",
  },
  {
    pattern: /^src\/auth\.ts$/i,
    why: "the HMAC and the constant-time comparison that verifier delegates to",
  },
  {
    pattern: /^src\/encoding\.ts$/i,
    why: "the hex encoding of the signature that verifier compares",
  },
  {
    pattern: /^src\/github\/client\.ts$/i,
    why: "the reader that supplies the changed paths and the CI facts every check judges",
  },
  // dustinedwards-info's judge files. One list, not one per namespace: every pattern is a
  // refusal, so inheriting another's can only refuse more.
  { pattern: /^\.github\/workflows\//i, why: "any workflow, which is what CI runs" },
  {
    pattern: /^scripts\/check-[^/]*\.mjs$/i,
    why: "a check script, which is what the Gates step runs",
  },
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
  {
    pattern: /^scripts\/verify-live\.mjs$/i,
    why: "the live gate, whose rollback is the backstop for an unattended merge",
  },
  // Install, build and deploy glue, which runs in CI or ships. Lockfiles are
  // no_migration_workflow_lockfile's, below.
  { pattern: /(^|\/)scripts\//i, why: "a script CI, a build or a deploy runs" },
  { pattern: /(^|\/)\.github\//i, why: "CI configuration beyond the workflows" },
  {
    pattern: /(^|\/)package\.json$/i,
    why: "a nested package manifest, whose scripts and dependencies an install runs",
  },
  {
    pattern: /(^|\/)(pnpm-workspace\.yaml|\.pnpmfile\.cjs|\.yarnrc[^/]*)$/i,
    why: "install configuration or a hook that runs during install",
  },
  { pattern: /(^|\/)\.npmrc$/i, why: "npm registry and install-script policy" },
  { pattern: /(^|\/)Dockerfile[^/]*$/i, why: "the image a build runs in" },
  { pattern: /(^|\/)Makefile$/i, why: "build glue CI executes" },
  { pattern: /(^|\/)\.husky\//i, why: "a git hook CI may run" },
  { pattern: /(^|\/)\.gitmodules$/i, why: "submodules the checkout would fetch and run" },
  // pr_recorded_for_job trusts result_ref and job_outcome_prs because only the job's
  // holder writes them. These two sources are what writes them, so a green PR that
  // loosened either could record any PR against any job. The job transitions are
  // src/jobs.ts and the jobs-* modules it re-exports.
  {
    pattern: /^src\/jobs(-[a-z]+)*\.ts$/i,
    why: "the job transitions that write result_ref, which pr_recorded_for_job reads",
  },
  {
    pattern: /^src\/outcome-prs(-[a-z]+)*\.ts$/i,
    why: "the writer of job_outcome_prs, which pr_recorded_for_job reads",
  },
];

export function refusedPathHits(paths: string[]): Array<{ path: string; why: string }> {
  const hits: Array<{ path: string; why: string }> = [];
  for (const path of paths) {
    const rule = AUTO_MERGE_REFUSED_PATHS.find(({ pattern }) => pattern.test(path));
    if (rule) hits.push({ path, why: rule.why });
  }
  return hits;
}

// The paths a namespace's pull requests may touch at all, for a namespace that carries a
// limit: every changed path must match one pattern. capsid carries one, because a capsid merge
// deploys the control plane: only docs outside docs/policy/ and the Portal's stylesheets merge
// unattended there. The one list that admits rather than refuses, so it is per namespace:
// inheriting another's would widen. Matched case-insensitively, like the refused paths.
export const AUTO_MERGE_ALLOWED_PATHS: Record<string, Array<{ pattern: RegExp; why: string }>> = {
  capsid: [
    {
      pattern: /^docs\/(?!policy\/).+$/i,
      why: "a document under docs/, except the policy sources in docs/policy/",
    },
    { pattern: /^dashboard\/.+\.css$/i, why: "a Portal stylesheet" },
  ],
};

/** The allowed-path rule for a namespace, or null when it has no limit. */
export function allowedPathsFor(namespace: string): Array<{ pattern: RegExp; why: string }> | null {
  return Object.hasOwn(AUTO_MERGE_ALLOWED_PATHS, namespace)
    ? AUTO_MERGE_ALLOWED_PATHS[namespace]
    : null;
}

/** Every allowed-path pattern as the document writes it, under its namespace's heading. */
export const namespacedAllowedPaths = (): string[] =>
  Object.entries(AUTO_MERGE_ALLOWED_PATHS).flatMap(([ns, rows]) =>
    rows.map((r) => `${ns} / ${r.pattern.source}`),
  );

// The CI steps a green PR must have run, per namespace. A repo's suites are steps of one job,
// so check-run names cannot show they ran: ci_green reads the steps of the newest run of each
// named workflow on the head sha, and every named step must have concluded success (a skipped
// step is not a pass). Per namespace because step names belong to the repo. A namespace with
// no list merges nothing.
export interface RequiredStep {
  workflow: string;
  job: string;
  step: string;
}

const ciStep =
  (job: string) =>
  (step: string): RequiredStep => ({ workflow: ".github/workflows/ci.yml", job, step });

export const AUTO_MERGE_REQUIRED_CI: Record<string, RequiredStep[]> = {
  // One typecheck step runs all four configs.
  capsid: [
    "Typecheck src, tests, integration tests and the copied scorer script",
    "Lint dead exports and doc drift",
    "Tests",
    "Integration tests",
  ].map(ciStep("checks")),
  // Every named step of both jobs of dustinedwards-info's ci.yml, read off main. Install and
  // build steps are named too, so a reordered workflow that drops one refuses. Command steps
  // carry no name, so GitHub reports them as "Run <command>".
  dustinedwards: [
    ...["Install", "Migrations, stack and content build, local sync", "Lint", "Gates", "Build"].map(
      ciStep("Gates, clean checkout"),
    ),
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
  // Every step of Carrel's two jobs, read off its ci.yml on main. Command steps carry no name,
  // so GitHub names them "Run <command>" and a script rename refuses until this list is updated.
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
    ...["Run npm ci", "Run npm run check:conformance", "Run npm run check:plants"].map(
      ciStep("gates"),
    ),
  ],
  // Every blocking step of Capsomer's `check` job, read off its ci.yml on main. Warn-only steps
  // (continue-on-error or always()) are left out: a pass proves nothing. The `results` job runs
  // on a push to main only; the No bloat workflow is warn-only by ruling.
  capsomer: [
    "Install",
    "Palette, scales, unit tests, types",
    "Every family's contrast pairs, both themes (blocking, rule 18)",
    "Build the behavior modules and wrappers",
    "Build the site and every states page",
    "Install Chromium",
    "Keyboard and accessibility tests, both themes",
  ].map(ciStep("check")),
};

/** The steps that namespace's pull requests must have run, or null when none are written down. */
export function requiredCiFor(namespace: string): RequiredStep[] | null {
  const rows = Object.hasOwn(AUTO_MERGE_REQUIRED_CI, namespace)
    ? AUTO_MERGE_REQUIRED_CI[namespace]
    : undefined;
  return rows && rows.length > 0 ? rows : null;
}

export const requiredCiLabel = (r: RequiredStep): string => `${r.workflow} / ${r.job} / ${r.step}`;

/** Every required step as the document writes it, under its namespace's heading. */
export const namespacedCiLabels = (): string[] =>
  Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) =>
    rows.map((r) => `${ns} / ${requiredCiLabel(r)}`),
  );

// Both directions: what the document lists and the code does not, and the reverse.
function listDisagreement(what: string, documented: string[], enforced: string[]): string | null {
  const unenforced = documented.filter((d) => !enforced.includes(d));
  const undocumented = enforced.filter((e) => !documented.includes(e));
  if (unenforced.length === 0 && undocumented.length === 0) return null;
  const parts: string[] = [];
  if (undocumented.length > 0)
    parts.push(`does not list ${undocumented.join(", ")}, which this Worker enforces`);
  if (unenforced.length > 0)
    parts.push(`lists ${unenforced.join(", ")}, which this Worker does not enforce`);
  return `the policy document's ${what} ${parts.join(", and ")}. Refusing rather than merging against a policy that disagrees with the code.`;
}

/** Read and verify the policy. A missing, unsigned or tampered document merges nothing. */
export async function loadMergePolicy(
  env: Env,
): Promise<{ policy: MergePolicy } | { error: string }> {
  const read = await readSignedPolicy(
    env,
    AUTO_MERGE_POLICY_PATH,
    "merge policy",
    "nothing is auto-merged",
  );
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
    AUTO_MERGE_REFUSED_PATHS.map((p) => p.pattern.source),
  );
  if (paths) return { error: paths };
  // Both directions here too: a limit the document drops would widen a namespace the
  // signer meant to hold narrow, and one it adds would be a limit nothing enforces.
  const allowed = listDisagreement(
    "allowed paths",
    parsed.policy.allowedPaths,
    namespacedAllowedPaths(),
  );
  if (allowed) return { error: allowed };
  const steps = listDisagreement(
    "required CI steps",
    parsed.policy.requiredCi,
    namespacedCiLabels(),
  );
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
