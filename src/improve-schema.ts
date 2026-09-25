export const ROSTER = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"] as const;

export type RosterNamespace = (typeof ROSTER)[number];

export function onRoster(namespace: string): namespace is RosterNamespace {
  return (ROSTER as readonly string[]).includes(namespace);
}

export const IMPROVE_MODES = ["api", "subscription", "off"] as const;
export type ImproveMode = (typeof IMPROVE_MODES)[number];

// Unset, unreadable, or unrecognised all resolve to off.
export const DEFAULT_MODE: ImproveMode = "off";

// Every improve key the Worker reads or writes, built by a function so no caller
// can typo a prefix into a keyspace nothing reaps.
export const MODE_KEY = "improve_mode";
export const bestKey = (namespace: string) => `improve:best:${namespace}`;
export const pausedKey = (namespace: string) => `improve:paused:${namespace}`;
// A pause the loop sets on itself carries this prefix, so the watcher can tell it
// from a pause a human set without matching words in the reason.
export const LOOP_PAUSE_PREFIX = "loop: ";
export const loopPauseReason = (reason: string) => `${LOOP_PAUSE_PREFIX}${reason}`;
export const anchorKey = (namespace: string) => `improve:anchor:${namespace}`;
// The meta-loop's weekly cadence marker. One key, not one per namespace: the
// meta-loop reasons across all of them at once.
export const META_LAST_KEY = "improve:meta:last";

// Subscription-mode driver lease. KV has no CAS, so this is best-effort.
// Six hours: past the longest observed driver run, under a day.
export const driverKey = (namespace: string) => `improve:driver:${namespace}`;
export const DRIVER_LEASE_TTL_SECONDS = 6 * 60 * 60;

// Monthly caps in KV. Missing or unreadable falls back to these, never to no cap.
export const BUDGET_KEY = "improve:budget";
export const BUDGET_DEFAULTS = { actions_minutes_month: 300, model_usd_month: 50 } as const;

export interface BudgetCaps {
  actions_minutes_month: number;
  model_usd_month: number;
  // The month the spend is measured over, "YYYY-MM". Unset means the current
  // UTC month; setting it forward is how a human resets the meter mid-month.
  month?: string;
}

// The commit a namespace is known good at (where to restore to) plus the scores that
// made it best (what a later run is compared against).
export interface BestRecord {
  sha: string;
  run_id: string;
  attempt_id: string | null;
  recorded_at: string;
  anchors: Record<string, number | null>;
  secondary: Record<string, number | null>;
  score: number;
}

// The holdout prefix, in the HOLDOUT bucket and nowhere else. Declared here so the
// scorer and the guard test agree on one spelling. The BINDING is what is
// restricted, and only src/improve-scorer.ts holds it.
export const HOLDOUT_PREFIX = "improve/holdout/";
export const holdoutManifestKey = (namespace: string) => `${HOLDOUT_PREFIX}${namespace}/manifest.json`;

// The Worker never reads the holdout tests (CI pulls them from R2), only their count,
// so a report claiming fewer holdout tests than the manifest lists is refused.
export interface HoldoutManifest {
  namespace: string;
  total: number;
  updated_at: string;
}

export const SCORES_PATH = "improve/scores.md";
export const RUN_TASK_PREFIX = "improve/run-";
export const RUN_PROMPT_PATH = "improve/prompts/run.md";
export const runTaskPath = (day: string) => `${RUN_TASK_PREFIX}${day}.md`;
export const archivePath = (runIdValue: string, attemptIdValue: string) =>
  `improve/archive/${runIdValue}/${attemptIdValue}.md`;
export const skillPath = (skillId: string) => `improve/skills/${skillId}.md`;
export const proposalPath = (kind: string, day: string) => `improve/proposals/${kind}-${day}.md`;

export const PROPOSAL_PREFIX = "improve/proposals/";

export const PROMPTS_PREFIX = "improve/prompts/";
export const SKILLS_PREFIX = "improve/skills/";

// The autonomy policy documents. Not under improve/, because they govern the work
// queue and the merge path as well as the loop.
export const POLICY_PREFIX = "policy/";


export const SCORER_WORKFLOW = "improve-score.yml";

export const RUN_STATUSES = [
  "opening",
  "attempting",
  "awaiting-score",
  "judging",
  "finalizing",
  "done",
  "paused",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// Finished; no tick touches the run again. Must match the partial unique index in
// migrations/0003_improve.sql (test/improve-state.test.ts asserts it).
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["done", "paused"];

export const RUN_CONDITIONS = ["full", "no-memory", "no-transfer"] as const;
export type RunCondition = (typeof RUN_CONDITIONS)[number];

export const DEFAULT_CONDITION: RunCondition = "full";

export function isRunCondition(value: string): value is RunCondition {
  return (RUN_CONDITIONS as readonly string[]).includes(value);
}

export const ATTEMPT_STATUSES = [
  "pending",
  "awaiting-score",
  "kept",
  "reverted",
  "flagged",
  "timed-out",
  // Pushed, then the budget cap refused the scorer dispatch. Never measured, and not
  // an environment failure either.
  "refused-budget",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// Attempts per run, per namespace, because a scorer run costs a different number of
// billed minutes in each repo (SCORER_BILLED_MINUTES). capsid is 10 because it is a
// public repo and its runs are not billed; the others spend a fixed monthly allowance.
const ATTEMPT_CAPS: Record<RosterNamespace, number> = {
  capsid: 10,
  dustinedwards: 2,
  foxhound: 2,
  foxing: 3,
  germomics: 3,
};

// An off-roster namespace gets the smallest cap, because nobody costed it.
export function maxAttemptsFor(namespace: string): number {
  return onRoster(namespace) ? ATTEMPT_CAPS[namespace] : Math.min(...Object.values(ATTEMPT_CAPS));
}

// A repo GitHub bills nothing for adds nothing to the minutes meter, which counts
// billed minutes only. For such a repo the binding cap is model_usd_month.
export function isFreeOfCharge(namespace: string): boolean {
  return (FREE_ROSTER as readonly string[]).includes(namespace);
}

// Billed minutes per scorer run (per job, rounded up, summed). Held against the cap at
// dispatch, so a scorer in flight counts, and replaced by the reported figure later.
const SCORER_BILLED_MINUTES: Record<RosterNamespace, number> = {
  capsid: 0,
  dustinedwards: 4.9,
  foxhound: 7.6,
  foxing: 3.9,
  germomics: 2.8,
};

// An off-roster namespace is charged the largest figure, because nobody costed it.
export function estimatedScorerMinutes(namespace: string): number {
  if (isFreeOfCharge(namespace)) return 0;
  return onRoster(namespace) ? SCORER_BILLED_MINUTES[namespace] : Math.max(...Object.values(SCORER_BILLED_MINUTES));
}

// What a reported scorer duration adds to the monthly meter; free repos add nothing.
// The report is wall clock, not billed minutes. Reading the billed figure from the
// Actions API would put an outbound call on the ingest path, so the gap is accepted.
export function meteredMinutes(namespace: string, reported: number): number {
  if (isFreeOfCharge(namespace)) return 0;
  return Number.isFinite(reported) && reported > 0 ? reported : 0;
}

// Billed namespaces open one per night, rotating. Free ones open every night.
const FREE_ROSTER = ["capsid"] as const;
const BILLED_ROTATION = ["foxhound", "dustinedwards", "foxing", "germomics"] as const;

// Keyed on the UTC day number, so two openers on one night agree and a night the
// loop was off does not shift the order.
export function scheduledFor(now: Date): RosterNamespace[] {
  const day = Math.floor(now.getTime() / 86_400_000);
  return [...FREE_ROSTER, BILLED_ROTATION[day % BILLED_ROTATION.length]];
}

// After this many reverts in a row the run restores to improve:best and stops.
// Consecutive, not cumulative: alternating keep and revert is slow progress.
export const MAX_CONSECUTIVE_REVERTS = 5;

// After this many unjudged attempts in a row (the scorer's environment failed) the
// run stops without restoring, since nothing was measured. Lower than the revert
// ceiling on purpose: a retry into a broken machine buys no information, and an
// attempt that crashes the scorer to escape judgement must not escape the revert
// counter by doing so.
export const MAX_CONSECUTIVE_UNJUDGED = 3;

// The scorer never produced a verdict: 'timed-out' is no report, 'unjudged' is a report
// saying its environment failed. Downstream treats them identically, through this list.
export const UNJUDGED_STATUSES = ["unjudged", "timed-out"] as const;

export function isUnjudged(status: string): boolean {
  return (UNJUDGED_STATUSES as readonly string[]).includes(status);
}

// How long a dispatched scorer workflow has to report back. Past it the attempt is
// left unjudged and the run continues rather than wedging.
//
// This must exceed the scorer workflow's own ceiling, the sum of the timeout-minutes
// along its longest needs chain: build (25) then score (20), so 45. Below that, a
// healthy run that takes its time is declared dead while still working, and the real
// report it posts afterwards is discarded as stale, with nothing reporting the loss.
//
// The wait is raised rather than the workflow lowered. Lowering the workflow kills
// healthy runs on the bigger repos, turning a slow success into a failure; this
// timeout exists only to stop a run wedging forever, so a longer wait costs only a
// slower recovery from a report that really was lost. Fifty is the 45 minute ceiling
// plus five for the queueing delay before a dispatched job starts.
//
// test/workflow-policy.test.ts derives both sides and fails if they drift apart.
export const SCORE_TIMEOUT_MS = 50 * 60 * 1000;

// A run alive this long finalizes wherever it is, so it cannot hold the namespace's
// one active-run slot when the next night's opener fires.
export const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// The drift gate. Over this share of reverts across the last three runs, or any
// anchor drop, and the namespace pauses.
export const DRIFT_REVERT_RATIO = 0.6;
export const DRIFT_RUN_WINDOW = 3;

export const META_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Cheap models for reading, the mid tier for writing code, the top tier for reasoning
// about the system. A map, so a new stage cannot pick a model implicitly.
export type ModelStage = "triage" | "monitor" | "attempt" | "abstract" | "meta";

export const MODEL_FOR: Record<ModelStage, string> = {
  // Reading a diff and answering a bounded question. Bare aliases, not dated snapshots.
  triage: "claude-haiku-4-5",
  monitor: "claude-haiku-4-5",
  // Writing the change.
  attempt: "claude-sonnet-5",
  // Cross-project reasoning: what does this change generalize to.
  abstract: "claude-opus-5",
  // Editing the run prompt itself.
  meta: "claude-opus-5",
};

// Matched by shape, not today's spellings, so a sixth repo's layout is covered.
export const PROTECTED_PATH_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)tests?\//i, why: "a test directory" },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/i, why: "a test file" },
  { pattern: /(^|\/)__tests__\//i, why: "a test directory" },
  { pattern: /(^|\/)\.github\//i, why: "CI configuration, including the scorer workflow" },
  { pattern: /(^|\/)improve\//i, why: "the improve loop's own documents" },
  { pattern: /(^|\/)src\/improve-/i, why: "the improve loop's own source" },
  { pattern: /(^|\/)migrations\//i, why: "a database migration" },
  { pattern: /(^|\/)wrangler\.(jsonc?|toml)(\.example)?$/i, why: "deployment configuration" },
  { pattern: /(^|\/)package(-lock)?\.json$/i, why: "the dependency manifest or lockfile" },
  { pattern: /(^|\/)npm-shrinkwrap\.json$/i, why: "a lockfile npm prefers over package-lock.json" },
  { pattern: /(^|\/)pnpm-lock\.yaml$/i, why: "the pnpm lockfile the scorer installs from" },
  { pattern: /(^|\/)pnpm-workspace\.yaml$/i, why: "the pnpm workspace definition" },
  { pattern: /(^|\/)\.pnpmfile\.cjs$/i, why: "a pnpm hook that runs during install" },
  { pattern: /(^|\/)yarn\.lock$/i, why: "the yarn lockfile" },
  { pattern: /(^|\/)\.yarnrc\.yml$/i, why: "yarn registry and install policy" },
  { pattern: /(^|\/)bun\.lockb$/i, why: "the bun lockfile" },
  { pattern: /(^|\/)deno\.lock$/i, why: "the deno lockfile" },
  { pattern: /(^|\/)\.gitmodules$/i, why: "submodules the checkout would fetch and run" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, why: "compiler configuration" },
  { pattern: /\.(config|conf)\.[cm]?[jt]s$/i, why: "a config file" },
  { pattern: /(^|\/)\.?eslint[^/]*$/i, why: "lint configuration" },
  { pattern: /(^|\/)\.claude\//i, why: "the agent steering layer" },
  { pattern: /(^|\/)CLAUDE\.md$/i, why: "the repo briefing" },
  { pattern: /(^|\/)\.nvmrc$/i, why: "the Node version the scorer runs" },
  { pattern: /(^|\/)\.node-version$/i, why: "the Node version the scorer runs" },
  { pattern: /(^|\/)\.npmrc$/i, why: "npm registry and install-script policy" },
  { pattern: /(^|\/)\.yarnrc[^/]*$/i, why: "yarn registry and install policy" },
  { pattern: /(^|\/)\.tool-versions$/i, why: "the toolchain versions asdf resolves" },
  { pattern: /(^|\/)\.gitattributes$/i, why: "what the checkout contains" },
  { pattern: /(^|\/)\.husky\//i, why: "a git hook CI may run" },
  { pattern: /(^|\/)scripts\//i, why: "scripts CI executes" },
  { pattern: /(^|\/)Makefile$/i, why: "build glue CI executes" },
  // Config the test runner or build reads that is JSON, a dotfile or has no extension.
  { pattern: /\.(config|conf)\.json$/i, why: "a config file" },
  { pattern: /(^|\/)\.babelrc[^/]*$/i, why: "compiler configuration" },
  { pattern: /(^|\/)\.mocharc[^/]*$/i, why: "test runner configuration" },
  { pattern: /(^|\/)vitest\.workspace\.[^/]+$/i, why: "test runner configuration" },
  { pattern: /(^|\/)\.env[^/]*$/i, why: "environment the build and tests read" },
  { pattern: /(^|\/)Dockerfile[^/]*$/i, why: "the image a build runs in" },
];

export interface ServedProtectedPath {
  pattern: string;
  flags: string;
  why: string;
}

export function servedProtectedPaths(): ServedProtectedPath[] {
  return PROTECTED_PATH_PATTERNS.map(({ pattern, why }) => ({ pattern: pattern.source, flags: pattern.flags, why }));
}

// Returns the reasons a change set is disqualified, or an empty array.
export function protectedHits(paths: string[]): Array<{ path: string; why: string }> {
  const hits: Array<{ path: string; why: string }> = [];
  for (const path of paths) {
    for (const { pattern, why } of PROTECTED_PATH_PATTERNS) {
      if (pattern.test(path)) {
        hits.push({ path, why });
        break;
      }
    }
  }
  return hits;
}

// Readable ids, because they become document paths, branch names and audit rows.
export function runId(namespace: string, now: Date): string {
  return `${namespace}-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

export function attemptId(runIdValue: string, index: number): string {
  return `${runIdValue}-a${String(index).padStart(2, "0")}`;
}

export const IMPROVE_BRANCH_PREFIX = "improve/";

export function branchName(attemptIdValue: string): string {
  return `${IMPROVE_BRANCH_PREFIX}${attemptIdValue}`;
}

/** True for a branch the improve loop owns. The refusal in delete_branch uses this. */
export function isImproveBranch(branch: string): boolean {
  return branch.startsWith(IMPROVE_BRANCH_PREFIX);
}

export function chicagoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function chicagoHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hour12: false,
  }).format(now);
  // Some ICU versions render midnight as "24" and others as "00"; both mean zero.
  return Number(hour) % 24;
}
