// ---- the roster -------------------------------------------------------------

export const ROSTER = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"] as const;

export type RosterNamespace = (typeof ROSTER)[number];

export function onRoster(namespace: string): namespace is RosterNamespace {
  return (ROSTER as readonly string[]).includes(namespace);
}

// ---- modes ------------------------------------------------------------------

export const IMPROVE_MODES = ["api", "subscription", "off"] as const;
export type ImproveMode = (typeof IMPROVE_MODES)[number];

// Unset, unreadable, or unrecognised all resolve to off.
export const DEFAULT_MODE: ImproveMode = "off";

// ---- KV keys ----------------------------------------------------------------

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

// A best record is the commit a namespace is known good at, plus the scores that
// made it best. Both halves are needed: the sha says where to restore to, the
// snapshot says what a later run is compared against.
export interface BestRecord {
  sha: string;
  run_id: string;
  attempt_id: string | null;
  recorded_at: string;
  anchors: Record<string, number | null>;
  secondary: Record<string, number | null>;
  score: number;
}

// ---- R2 ---------------------------------------------------------------------

// The holdout prefix, in the HOLDOUT bucket and nowhere else. Declared here so the
// scorer and the guard test agree on one spelling. The BINDING is what is
// restricted, and only src/improve-scorer.ts holds it.
export const HOLDOUT_PREFIX = "improve/holdout/";
export const holdoutManifestKey = (namespace: string) => `${HOLDOUT_PREFIX}${namespace}/manifest.json`;

// What the manifest says about a namespace's hidden suite. The Worker never reads
// the TESTS: CI pulls those straight from R2 with its own read-only token. The
// Worker reads only the COUNT, and that is what makes a score report checkable.
// A report claiming 3 holdout tests passed when the manifest says 11 exist is
// refused, so "delete the failing holdout tests" is not a way to score well.
export interface HoldoutManifest {
  namespace: string;
  total: number;
  updated_at: string;
}

// ---- document paths ---------------------------------------------------------

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

// THE AUTONOMY POLICY DOCUMENTS. Not under improve/, because they govern the work
// queue and the merge path as well as the loop, and a reader looking for what the
// machine may do alone should not have to know the loop exists to find them.
export const POLICY_PREFIX = "policy/";


export const SCORER_WORKFLOW = "improve-score.yml";

// ---- states -----------------------------------------------------------------

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

// A run in one of these is finished and no tick touches it again. The partial
// unique index in migrations/0003_improve.sql names the same two values, and
// test/improve-state.test.ts asserts the two agree: a terminal status added here
// and not there would let two active runs exist for one namespace.
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

// ---- the numbers ------------------------------------------------------------

// Per namespace per run, and PER NAMESPACE rather than one global number,
// because one scorer run costs a different number of BILLED minutes in each
// repo. Measured 2026-09-15 over 78 runs: foxhound 7.6, dustinedwards 4.9,
// foxing 3.9, germomics 2.8, capsid 2.3.
//
// CAPSID IS 10 BECAUSE ITS RUNS COST NOTHING, NOT BECAUSE IT IS TRUSTED MORE.
// That repo is public and GitHub bills no Actions minutes for a public repo, so
// its 10 buys nothing from the allowance. Every other number here is bought from
// a 2,000-minute month that is a hard stop rather than a bill, and at the rates
// above one attempt across the four billed namespaces costs 19.2 minutes.
// Raising one without re-measuring spends an allowance nobody is watching.
const ATTEMPT_CAPS: Record<RosterNamespace, number> = {
  capsid: 10,
  dustinedwards: 2,
  foxhound: 2,
  foxing: 3,
  germomics: 3,
};

// The attempt ceiling for one namespace. An off-roster caller gets the SMALLEST
// cap rather than a default, because a namespace nobody costed is the one least
// safe to be generous with.
export function maxAttemptsFor(namespace: string): number {
  return onRoster(namespace) ? ATTEMPT_CAPS[namespace] : Math.min(...Object.values(ATTEMPT_CAPS));
}

// A REPO GITHUB BILLS NOTHING FOR CONTRIBUTES NOTHING TO THE METER. Ruled
// 2026-09-15: a cap denominated in minutes counts minutes that are BILLED. capsid
// is public, its 30 scorer runs in the September cycle took 2.3 minutes each and
// cost zero, and counting that wall clock would have paused the entire roster
// after roughly 13 nights over minutes nobody was ever charged for. For capsid the
// binding cap is model_usd_month, which is the honest one.
export function isFreeOfCharge(namespace: string): boolean {
  return (FREE_ROSTER as readonly string[]).includes(namespace);
}

// WHAT ONE SCORER RUN COSTS, IN THE UNIT GITHUB BILLS IN: per job, rounded up to
// the minute, summed. Measured 2026-09-15 over the 78 runs of the September cycle.
// Held against the cap AT DISPATCH, so a scorer in flight is not invisible to the
// next check, and replaced by the reported figure when the report lands.
const SCORER_BILLED_MINUTES: Record<RosterNamespace, number> = {
  capsid: 0,
  dustinedwards: 4.9,
  foxhound: 7.6,
  foxing: 3.9,
  germomics: 2.8,
};

// An off-roster namespace is charged the LARGEST figure rather than a default,
// because a namespace nobody costed is the one least safe to guess cheap on.
export function estimatedScorerMinutes(namespace: string): number {
  if (isFreeOfCharge(namespace)) return 0;
  return onRoster(namespace) ? SCORER_BILLED_MINUTES[namespace] : Math.max(...Object.values(SCORER_BILLED_MINUTES));
}

// What a REPORTED scorer duration contributes to the monthly meter. Free repos
// contribute nothing. The reported figure is wall clock across the scorer's two
// jobs, which is not the unit the allowance is billed in; that gap is accepted
// deliberately (ruled 2026-09-15) because reading the exact figure back from the
// Actions API would put an outbound call on the ingest path, and the revert path
// is worth more network-free than the meter is worth exact.
export function meteredMinutes(namespace: string, reported: number): number {
  if (isFreeOfCharge(namespace)) return 0;
  return Number.isFinite(reported) && reported > 0 ? reported : 0;
}

// The billed namespaces open ONE PER NIGHT, rotating, so a night costs one
// namespace's attempts rather than four. capsid is not in the rotation because
// its runs are free, so it opens every night.
const FREE_ROSTER = ["capsid"] as const;
const BILLED_ROTATION = ["foxhound", "dustinedwards", "foxing", "germomics"] as const;

// Which namespaces open tonight. Keyed on the UTC day NUMBER so the answer is a
// pure function of the date: two opener invocations on the same night agree, and
// a night the loop was off does not shift the order for every night after it.
export function scheduledFor(now: Date): RosterNamespace[] {
  const day = Math.floor(now.getTime() / 86_400_000);
  return [...FREE_ROSTER, BILLED_ROTATION[day % BILLED_ROTATION.length]];
}

// After this many reverts in a row the run restores to improve:best and stops.
// Consecutive rather than cumulative: a run alternating keep and revert is
// learning slowly, a run reverting five times running has lost the thread.
export const MAX_CONSECUTIVE_REVERTS = 5;

// After this many UNJUDGED attempts in a row the run stops, without restoring to
// improve:best. Unjudged is an environment failure: the scorer never produced a
// measurement, so nothing is known about the code and there is nothing to restore
// away from.
//
// THREE, AND LOWER THAN THE REVERT CEILING ON PURPOSE, for two reasons.
//
// A revert at least bought a measurement, so spending another attempt after one is
// buying information. An unjudged attempt bought nothing, so a third, fourth and
// fifth dispatch into a machine that is still broken spend CI minutes and model
// cost to learn the same nothing. Two retries is enough to ride out a transient
// runner eviction or a registry blip, which is what most of these are.
//
// And it bounds the one thing this status could otherwise be used for. Unjudged
// costs an attempt nothing: it is not counted, and the skill that proposed it is
// not marked. An attempt that could tell it was about to fail would therefore
// rather crash the scorer than be judged by it, and killing the container is within
// reach of code the container runs. It cannot get the attempt KEPT, so the most it
// buys is escaping the revert counter, and a ceiling below that counter's is what
// takes the escape back.
export const MAX_CONSECUTIVE_UNJUDGED = 3;

// The attempt statuses that mean "the scorer never produced a verdict on this".
// Two spellings because the two failures are worth telling apart in the record:
// 'timed-out' is no report at all, 'unjudged' is a report that arrived saying its
// own environment failed. Everything downstream treats them identically, and this
// list is what makes that true in one place rather than in each caller.
export const UNJUDGED_STATUSES = ["unjudged", "timed-out"] as const;

export function isUnjudged(status: string): boolean {
  return (UNJUDGED_STATUSES as readonly string[]).includes(status);
}

// How long a dispatched scorer workflow has to report back. Past it the attempt is
// left UNJUDGED and the run continues rather than wedging.
//
// THIS MUST EXCEED THE SCORER WORKFLOW'S OWN CEILING, which is the sum of the
// timeout-minutes along its longest needs chain: build (25) then score (20), so 45.
// It was 20 against that 45, so a healthy run that took its time was declared dead
// while it was still working, and the real report it posted afterwards was then
// discarded as stale. Nothing reported the loss.
//
// Raised rather than lowering the workflow's side. Lowering the workflow kills
// healthy runs on the bigger repos, which converts a slow success into a failure;
// this timeout exists only to stop a run wedging forever, so a longer wait costs
// nothing but a slower recovery from a report that really was lost. Fifty is the 45
// minute ceiling plus five for the queueing delay before a dispatched job starts.
//
// test/workflow-pins.test.ts derives both sides and fails if they drift apart.
export const SCORE_TIMEOUT_MS = 50 * 60 * 1000;

// A run alive this long finalizes wherever it is. The nightly cadence is the
// reason: a run still crawling at hour seven would still hold the namespace's one
// active-run slot when the next night's opener fires.
export const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// The drift gate. Over this share of reverts across the last three runs, or any
// anchor drop, and the namespace pauses.
export const DRIFT_REVERT_RATIO = 0.6;
export const DRIFT_RUN_WINDOW = 3;

export const META_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// ---- model routing ----------------------------------------------------------

// Cheap models for reading, the mid tier for writing code, the top tier only
// where the reasoning is about the system rather than about one change. A map
// rather than three constants, so the routing can be asserted whole by a test and
// so a new stage cannot pick a model implicitly.
export type ModelStage = "triage" | "monitor" | "attempt" | "abstract" | "meta";

export const MODEL_FOR: Record<ModelStage, string> = {
  // Reading a diff and answering a bounded question about it. The bare alias,
  // not the dated snapshot: the dated form resolves too, and pinning it here
  // would make this file the one place a model upgrade has to be remembered.
  triage: "claude-haiku-4-5",
  monitor: "claude-haiku-4-5",
  // Writing the change.
  attempt: "claude-sonnet-5",
  // Cross-project reasoning: what does this change generalize to.
  abstract: "claude-opus-5",
  // Editing the run prompt itself.
  meta: "claude-opus-5",
};

// ---- protected paths --------------------------------------------------------

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
  // Audit 2026-09-25, E2-L13: config the test runner or build reads that the patterns
  // above missed, because they are JSON, dotfiles or have no extension.
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

// ---- ids --------------------------------------------------------------------

// Run and attempt ids are readable on purpose: they become document paths
// (improve/archive/<run_id>/<attempt_id>.md), branch names and audit rows, and an
// opaque uuid in all three costs more than the characters it saves.
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
  // en-US with hour12 false renders midnight as "24" in some ICU versions and
  // "00" in others. Both mean hour zero; normalising here keeps the opener from
  // firing on a day boundary in one runtime and not in another.
  return Number(hour) % 24;
}
