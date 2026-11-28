import { isMoneyPath } from "./scope";

// AUTOMATIC MODEL ROUTING (capsid/research/design-model-routing.md). the rules are data, and they
// change only through a seat-approved edit here, never from the evidence alone (proposeRuleChanges
// only proposes).

// The sources that judge a change or ship beside it: a diff here raises a job's risk and is worth a
// second reader.
export const JUDGE_PATHS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/gate-policy\.ts$/i, why: "the gate policy source" },
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
    why: "verifySignedBody, which decides a stored policy or job body is signed",
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
    why: "the live gate, whose rollback is the backstop for a merge",
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

export const JOB_KINDS = [
  "watcher",
  "design",
  "security",
  "build",
  "maintenance",
  "docs",
  "mechanical",
  "other",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const isJobKind = (value: unknown): value is JobKind =>
  typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);

// Claude Code's model aliases (code.claude.com/docs/en/model-config): opusplan is Opus in plan
// mode and Sonnet for execution. Ordered cheapest first, which is the order the learning step
// reads "cheaper" and "more capable" in.
export const MODELS = ["haiku", "sonnet", "opusplan", "opus"] as const;
export type RoutedModel = (typeof MODELS)[number];

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];

export const ROUTING_RULES_VERSION = 2;

export const WATCHER_ACTOR_NAME = "agent:watcher";

// How a job's kind is read when the poster gave none. First match wins. The title is read, never
// the body: a body is long, and almost every Capsid body mentions backups, secrets and docs.
const KIND_RULES: ReadonlyArray<{ kind: JobKind; title: RegExp; why: string }> = [
  { kind: "watcher", title: /^Watcher:/, why: "a watcher finding" },
  { kind: "design", title: /^Design\b/i, why: "a design job" },
  {
    kind: "security",
    title: /\b(security|OWASP|credential|secret|JWT|authentication)\b/i,
    why: "names a security surface",
  },
  { kind: "build", title: /^Build\b/i, why: "a build job" },
  {
    kind: "docs",
    title:
      /^(docs?|documentation)\b|^(update|write|fix|rewrite) (the )?(docs?|documentation|readme|changelog)\b/i,
    why: "documentation",
  },
  {
    kind: "maintenance",
    title:
      /^(re-?pin|pin|update|bump)\b|\b(dependenc(y|ies)|renovate|backups?|allotment|allowance|prun(e|ing))\b/i,
    why: "routine maintenance",
  },
  {
    kind: "mechanical",
    title: /\b(rename|typo|reformat|find and replace)\b/i,
    why: "a mechanical edit",
  },
];

export interface KindVerdict {
  kind: JobKind;
  source: "given" | "watcher" | "title" | "default";
}

export function deriveKind(job: {
  title: string;
  posted_by: string;
  kind?: string | null;
}): KindVerdict {
  if (isJobKind(job.kind)) return { kind: job.kind, source: "given" };
  if (job.posted_by === WATCHER_ACTOR_NAME) return { kind: "watcher", source: "watcher" };
  const hit = KIND_RULES.find((rule) => rule.title.test(job.title));
  return hit ? { kind: hit.kind, source: "title" } : { kind: "other", source: "default" };
}

// Namespaces whose work is risky by what they are: foxhound takes payments (capsid/conventions.md
// leaves its parity-first rule in force).
const HIGH_RISK_NAMESPACES: ReadonlyArray<{ namespace: string; why: string }> = [
  { namespace: "foxhound", why: "a payments product" },
];

const HIGH_RISK_FLAGS = new Set(["can_merge", "can_touch_protected"]);

export interface Risk {
  level: "high" | "routine" | "unread";
  reasons: string[];
  // What was read, so "routine" over nothing cannot pass for "routine over a PR's files".
  files_read: number;
}

export function riskFromJob(job: {
  namespace: string;
  required_flags?: readonly string[];
  gate_required?: boolean;
}): Risk {
  const reasons: string[] = [];
  const ns = HIGH_RISK_NAMESPACES.find((n) => n.namespace === job.namespace);
  if (ns) reasons.push(`${job.namespace} is ${ns.why}`);
  const flags = (job.required_flags ?? []).filter((f) => HIGH_RISK_FLAGS.has(f));
  if (flags.length) reasons.push(`requires ${flags.join(", ")}`);
  if (job.gate_required) reasons.push("needs a human confirmation (push, deploy, secret or merge)");
  return { level: reasons.length ? "high" : "routine", reasons, files_read: 0 };
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  deletions?: number;
}

export const DELETION_LINES_HIGH = 300;
const BACKUP_PATH = /(^|\/)(backups?|restore[-_a-z]*|dump[-_a-z]*)(\/|[-_.]|$)/i;

/**
 * Risk once a pull request exists, from its changed files: the money paths and JUDGE_PATHS, plus
 * deletions and backups. A rename is judged under both names.
 * No files is "unread", never "routine".
 */
export function riskOf(files: readonly ChangedFile[]): Risk {
  if (files.length === 0)
    return { level: "unread", reasons: ["no changed files were read"], files_read: 0 };
  const reasons = new Set<string>();
  let deleted = 0;
  for (const file of files) {
    for (const path of file.previous_filename
      ? [file.previous_filename, file.filename]
      : [file.filename]) {
      if (isMoneyPath(path)) reasons.add(`${path} is a billing or payment path`);
      const judge = JUDGE_PATHS.find(({ pattern }) => pattern.test(path));
      if (judge) reasons.add(`${path} is ${judge.why}`);
      if (BACKUP_PATH.test(path)) reasons.add(`${path} is a backup or restore path`);
    }
    if (file.status === "removed") reasons.add(`${file.filename} is deleted`);
    deleted += file.deletions ?? 0;
  }
  if (deleted >= DELETION_LINES_HIGH)
    reasons.add(`${deleted} lines are deleted, at or over ${DELETION_LINES_HIGH}`);
  return {
    level: reasons.size ? "high" : "routine",
    reasons: [...reasons].slice(0, 12),
    files_read: files.length,
  };
}

// Only code is judged: a document, image, test, lockfile or JSON manifest is never the reason on
// its own.
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql|sh)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
export const TEST_FILE =
  /(^|\/)(test|tests|test-integration|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

// The sources that hold this repo's invariants and credentials, beside JUDGE_PATHS because a diff
// there raises no job's risk on its own (the snapshot, one enforcement point and path mutation
// invariants, test/write-invariants.test.ts, test/scope.test.ts and
// test/path-mutation.test.ts, and the login and key paths).
const GUARD_SOURCES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^src\/store-guards\.ts$/i,
    why: "the snapshot and audit guard every overwrite and delete runs through",
  },
  { pattern: /^src\/tools\/repo\.ts$/i, why: "guardedWrite, the one gate on repo mutations" },
  { pattern: /^src\/tools\/docs\.ts$/i, why: "pathMutation, the only way a path changes" },
  {
    pattern: /^src\/(access-login|portal-auth)\.ts$/i,
    why: "a login or session check",
  },
  { pattern: /^src\/(job-signing)\.ts$/i, why: "a key or a signature" },
  { pattern: /^src\/agents(-admin)?\.ts$/i, why: "the minting and grants of agent credentials" },
];

export interface ReviewWorthiness {
  level: "worth" | "skip" | "unread";
  reasons: string[];
  files_read: number;
}

/**
 * Whether a pull request's diff is worth a second reader: code that is money, a judge on
 * JUDGE_PATHS, a guard or credential source, a migration, a workflow, or backup and
 * restore code. No files is "unread", never "skip".
 */
export function worthReviewer(files: readonly ChangedFile[]): ReviewWorthiness {
  if (files.length === 0)
    return { level: "unread", reasons: ["no changed files were read"], files_read: 0 };
  const reasons = new Set<string>();
  for (const file of files) {
    for (const path of file.previous_filename
      ? [file.previous_filename, file.filename]
      : [file.filename]) {
      const workflow = WORKFLOW_FILE.test(path);
      if (!workflow && (!CODE_FILE.test(path) || TEST_FILE.test(path))) continue;
      if (workflow) {
        reasons.add(`${path} is a workflow, which holds CI's permissions and secrets`);
        continue;
      }
      if (isMoneyPath(path)) reasons.add(`${path} is billing or payment code`);
      const judge = JUDGE_PATHS.find(({ pattern }) => pattern.test(path));
      if (judge) reasons.add(`${path} is ${judge.why}`);
      const guard = GUARD_SOURCES.find(({ pattern }) => pattern.test(path));
      if (guard) reasons.add(`${path} is ${guard.why}`);
      if (BACKUP_PATH.test(path) && /^(src|scripts)\//i.test(path))
        reasons.add(`${path} is backup or restore code`);
    }
  }
  return {
    level: reasons.size ? "worth" : "skip",
    reasons: [...reasons].slice(0, 12),
    files_read: files.length,
  };
}

// THE RULES, as data. First match wins; a high risk comes first, so a routine kind with a risky
// shape is upgraded rather than left on the cheap model.
export interface RoutingRule {
  when: { risk?: "high"; kind?: JobKind };
  model: RoutedModel;
  effort: Effort;
  why: string;
}

export const ROUTING_RULES: readonly RoutingRule[] = [
  {
    when: { risk: "high" },
    model: "opus",
    effort: "high",
    why: "risky work gets the strongest model",
  },
  {
    when: { kind: "design" },
    model: "opus",
    effort: "high",
    why: "design is judgment, not execution",
  },
  {
    when: { kind: "security" },
    model: "opus",
    effort: "high",
    why: "a security change is read as an attacker would",
  },
  {
    when: { kind: "build" },
    model: "opusplan",
    effort: "high",
    why: "a large build: Opus plans, Sonnet executes",
  },
  {
    when: { kind: "watcher" },
    model: "sonnet",
    effort: "medium",
    why: "a watcher finding is routine maintenance",
  },
  { when: { kind: "maintenance" }, model: "sonnet", effort: "medium", why: "routine maintenance" },
  { when: { kind: "docs" }, model: "sonnet", effort: "low", why: "documentation" },
  { when: { kind: "mechanical" }, model: "haiku", effort: "low", why: "a mechanical edit" },
  {
    when: {},
    model: "opusplan",
    effort: "medium",
    why: "no rule names this kind, so the repo default",
  },
];

// An arm keeps the rule's effort, so the comparison is of the model alone. A risky job, or one
// whose body names its model, never takes an arm. Which jobs take it is a stable hash of the job
// id, so post and claim agree.
export interface TrialArm {
  kind: JobKind;
  model: RoutedModel;
  percent: number;
}

export const TRIAL_ARMS: readonly TrialArm[] = [
  { kind: "watcher", model: "haiku", percent: 25 },
  { kind: "maintenance", model: "haiku", percent: 25 },
  { kind: "docs", model: "haiku", percent: 25 },
];

/**
 * The job's place, 0 to 99, in every trial: FNV-1a over the id. Deterministic and synchronous, so
 * the post and every later claim of the job read the same number.
 */
export function trialBucket(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export interface Routing {
  kind: JobKind;
  kind_source: KindVerdict["source"];
  model: RoutedModel;
  effort: Effort;
  risk: Risk["level"];
  trial: RoutedModel | null;
  reason: string;
  rules_version: number;
}

// A model a job names for itself, "model: opus" on a line of its own in the body. Read from the
// body's own text, which the signature covers, so it is the poster's word.
const NAMED_MODEL = /^\s*model\s*[:=]\s*(haiku|sonnet|opusplan|opus)\s*$/im;

export function routeJob(job: {
  id?: string | null;
  title: string;
  body?: string | null;
  namespace: string;
  posted_by: string;
  kind?: string | null;
  required_flags?: readonly string[];
  gate_required?: boolean;
  pr_risk?: Risk | null;
}): Routing {
  const k = deriveKind(job);
  const fromJob = riskFromJob(job);
  const risk: Risk = job.pr_risk && job.pr_risk.level === "high" ? job.pr_risk : fromJob;
  const rule = ROUTING_RULES.find((r) =>
    r.when.risk ? risk.level === r.when.risk : r.when.kind ? r.when.kind === k.kind : true,
  )!;
  // A named model may raise a risky job's model, never lower it below the risk rule's.
  const asked = job.body
    ? (NAMED_MODEL.exec(job.body)?.[1]?.toLowerCase() as RoutedModel | undefined)
    : undefined;
  const overruled =
    asked !== undefined &&
    rule.when.risk !== undefined &&
    MODELS.indexOf(asked) < MODELS.indexOf(rule.model);
  const named = overruled ? undefined : asked;
  // The risk rule comes first, so a rule matched by kind means the job is routine.
  const arm =
    !named && rule.when.kind && job.id
      ? TRIAL_ARMS.find((a) => a.kind === k.kind && a.model !== rule.model)
      : undefined;
  const trial = arm && job.id && trialBucket(job.id) < arm.percent ? arm.model : null;
  const model = named ?? trial ?? rule.model;
  const why = named
    ? `the job names ${named}`
    : risk.level === "high" && rule.when.risk
      ? `${rule.why}${overruled ? `, not the ${asked} the job names` : ""}: ${risk.reasons.join("; ")}`
      : trial
        ? `trial arm: ${trial} on ${arm!.percent} percent of routine ${k.kind} jobs, measured against ${rule.model} (kind ${k.kind}, ${k.source})`
        : `${rule.why} (kind ${k.kind}, ${k.source})`;
  return {
    kind: k.kind,
    kind_source: k.source,
    model,
    effort: rule.effort,
    risk: risk.level,
    trial,
    reason: why.slice(0, 300),
    rules_version: ROUTING_RULES_VERSION,
  };
}
