import type { Env } from "./env";
import type { PrFacts } from "./auto-merge-policy-evaluate";
import { parseMergePolicy, type MergePolicy } from "./auto-merge-policy-parse";
import { readSignedPolicy } from "./signed-docs";

// The document capsid/policy/auto-merge.md, signed like a task document, decides whether this Worker
// may write to a default branch that deploys on push. An unsigned or edited policy merges nothing.
export const AUTO_MERGE_POLICY_PATH = "policy/auto-merge.md";

// The three path checks run first (the never list). Changing who may author an unattended merge is a
// signed act (pr_author_allowed).
export const POLICY_CHECKS = [
  "paths_not_refused",
  "paths_not_money",
  "no_migration_workflow_lockfile",
  "paths_allowed_for_namespace",
  "head_in_base_repo",
  "pr_author_allowed",
  "base_is_default_branch",
  "size_within_cap",
  "ci_green",
] as const;

export type PolicyCheck = (typeof POLICY_CHECKS)[number];

// Over it, the merge class is approve (one tap, "over the size cap"): a big diff is where a review earns its time.
export const AUTO_MERGE_SIZE_CAP = 1000;

// Uncounted is not over it; the policy refuses an uncounted pull request on its own.
export const overSizeCap = (facts: Pick<PrFacts, "changedLines">): boolean =>
  facts.changedLines !== null && facts.changedLines > AUTO_MERGE_SIZE_CAP;

export const sizeCapReason = (facts: Pick<PrFacts, "changedLines">): string =>
  `over the size cap: ${facts.changedLines} changed lines, more than ${AUTO_MERGE_SIZE_CAP}`;

// Tests, src/, docs, CLAUDE.md and .claude/ merge on green; these change what judges a change or what
// ships beside it.
export const AUTO_MERGE_REFUSED_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/gate-policy\.ts$/i, why: "the gate policy source" },
  {
    pattern: /^src\/auto-merge(-[a-z]+)*\.ts$/i,
    why: "the auto-merge source, which holds this list",
  },
  { pattern: /^src\/policy-sign(-[a-z]+)*\.ts$/i, why: "the policy signer" },
  { pattern: /^src\/protected-paths\.ts$/i, why: "the protected path list" },
  // The sources the checks read their answers from, not only the ones that run them: otherwise a
  // green driver PR weakens the source and the next PR passes the check it weakened.
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
  // The job queue's own sources: they hold claims and the records of what a job's holder did.
  {
    pattern: /^src\/jobs(-[a-z]+)*\.ts$/i,
    why: "the job transitions, which write claims and results",
  },
  {
    pattern: /^src\/outcome-prs(-[a-z]+)*\.ts$/i,
    why: "the writer of job_outcome_prs",
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

// The one list that admits rather than refuses, so it is per namespace: inheriting another's would widen.
export const AUTO_MERGE_ALLOWED_PATHS: Record<string, Array<{ pattern: RegExp; why: string }>> = {
  capsid: [
    {
      pattern: /^docs\/(?!policy\/).+$/i,
      why: "a document under docs/, except the policy sources in docs/policy/",
    },
    { pattern: /^dashboard\/.+\.css$/i, why: "a Portal stylesheet" },
  ],
};

export function allowedPathsFor(namespace: string): Array<{ pattern: RegExp; why: string }> | null {
  return Object.hasOwn(AUTO_MERGE_ALLOWED_PATHS, namespace)
    ? AUTO_MERGE_ALLOWED_PATHS[namespace]
    : null;
}

export const namespacedAllowedPaths = (): string[] =>
  Object.entries(AUTO_MERGE_ALLOWED_PATHS).flatMap(([ns, rows]) =>
    rows.map((r) => `${ns} / ${r.pattern.source}`),
  );

// A repo's suites are steps of one job, so check-run names cannot show they ran: ci_green reads the
// newest run's steps, and a skipped step is not a pass.
export interface RequiredStep {
  workflow: string;
  job: string;
  step: string;
}

const ciStep =
  (job: string) =>
  (step: string): RequiredStep => ({ workflow: ".github/workflows/ci.yml", job, step });

export const AUTO_MERGE_REQUIRED_CI: Record<string, RequiredStep[]> = {
  capsid: [
    "Typecheck src, tests, integration tests and the copied scorer script",
    "Lint dead exports and doc drift",
    "Tests",
    "Integration tests",
  ].map(ciStep("checks")),
  // Install and build steps are named too, so a reordered workflow that drops one refuses. Command
  // steps carry no name, so GitHub reports them as "Run <command>".
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
  // Warn-only steps (continue-on-error or always()) are left out: a pass proves nothing. The `results`
  // job runs on a push to main only; the No bloat workflow is warn-only by ruling.
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

export function requiredCiFor(namespace: string): RequiredStep[] | null {
  const rows = Object.hasOwn(AUTO_MERGE_REQUIRED_CI, namespace)
    ? AUTO_MERGE_REQUIRED_CI[namespace]
    : undefined;
  return rows && rows.length > 0 ? rows : null;
}

export const requiredCiLabel = (r: RequiredStep): string => `${r.workflow} / ${r.job} / ${r.step}`;

export const namespacedCiLabels = (): string[] =>
  Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) =>
    rows.map((r) => `${ns} / ${requiredCiLabel(r)}`),
  );

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

// The one place a body is judged loadable, so a body signed from the repo is held to what the loader will.
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
  // Both directions here too: a limit the document drops would widen a namespace the signer meant to
  // hold narrow, and one it adds would be a limit nothing enforces.
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
  // Without this, ci_green's step check would have nothing to compare and would pass on any run that
  // reported at all, so a widening here would be quiet rather than fail closed.
  const uncovered = parsed.policy.namespaces.filter((n) => requiredCiFor(n) === null);
  if (uncovered.length > 0) {
    return {
      error: `the policy covers ${uncovered.join(", ")}, for which this Worker holds no required CI steps. A green run there would prove nothing, so it is refused rather than merged.`,
    };
  }
  return parsed;
}
