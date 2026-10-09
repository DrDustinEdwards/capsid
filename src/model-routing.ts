import { AUTO_MERGE_REFUSED_PATHS } from "./auto-merge-policy";
import { isMoneyPath } from "./scope";

// AUTOMATIC MODEL ROUTING (capsid/research/design-model-routing.md). Capsid picks the
// model for every job from its kind and its risk, so nobody chooses a model by hand. The
// recommendation is a function of the job and the rules below; the rules are data, and
// they change only through a seat-approved edit here, never from the evidence alone
// (proposeRuleChanges only proposes).
//
// What this module does NOT do: start a session on the model. That is the driver's step
// (capsid/conventions.md, "Model routing"): a launch passes --model, and an interactive
// driver runs the job's work in a subagent on the recommended model.

export const JOB_KINDS = ["watcher", "design", "security", "build", "maintenance", "docs", "mechanical", "other"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const isJobKind = (value: unknown): value is JobKind => typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);

// Claude Code's model aliases (code.claude.com/docs/en/model-config): opusplan is Opus in
// plan mode and Sonnet for execution. Ordered cheapest first, which is the order the
// learning step reads "cheaper" and "more capable" in.
export const MODELS = ["haiku", "sonnet", "opusplan", "opus"] as const;
export type RoutedModel = (typeof MODELS)[number];

const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

// Bumped when ROUTING_RULES or KIND_RULES change, and stored with each recommendation's
// reason, so an outcome can be read against the rules that chose its model.
export const ROUTING_RULES_VERSION = 1;

// THE WATCHER'S ACTOR, as src/watcher.ts defines it. A literal here so this module does
// not import the watcher; test/model-routing.test.ts holds the two together.
export const WATCHER_ACTOR_NAME = "agent:watcher";

// How a job's kind is read when the poster gave none. First match wins. The title is
// read, never the body: a body is long, and almost every Capsid body mentions backups,
// secrets and docs.
const KIND_RULES: ReadonlyArray<{ kind: JobKind; title: RegExp; why: string }> = [
  { kind: "watcher", title: /^Watcher:/, why: "a watcher finding" },
  { kind: "design", title: /^Design\b/i, why: "a design job" },
  { kind: "security", title: /\b(security|OWASP|credential|secret|JWT|authentication)\b/i, why: "names a security surface" },
  { kind: "build", title: /^Build\b/i, why: "a build job" },
  { kind: "docs", title: /^(docs?|documentation)\b|^(update|write|fix|rewrite) (the )?(docs?|documentation|readme|changelog)\b/i, why: "documentation" },
  { kind: "maintenance", title: /^(re-?pin|pin|update|bump)\b|\b(dependenc(y|ies)|renovate|backups?|allotment|allowance|prun(e|ing))\b/i, why: "routine maintenance" },
  { kind: "mechanical", title: /\b(rename|typo|reformat|find and replace)\b/i, why: "a mechanical edit" },
];

export interface KindVerdict {
  kind: JobKind;
  // "given" (the poster set it), "title" (a KIND_RULES match), "default" (nothing matched).
  source: "given" | "watcher" | "title" | "default";
}

export function deriveKind(job: { title: string; posted_by: string; kind?: string | null }): KindVerdict {
  if (isJobKind(job.kind)) return { kind: job.kind, source: "given" };
  if (job.posted_by === WATCHER_ACTOR_NAME) return { kind: "watcher", source: "watcher" };
  const hit = KIND_RULES.find((rule) => rule.title.test(job.title));
  return hit ? { kind: hit.kind, source: "title" } : { kind: "other", source: "default" };
}

// RISK.

// Namespaces whose work is risky by what they are: foxhound takes payments
// (capsid/conventions.md leaves its parity-first rule in force).
const HIGH_RISK_NAMESPACES: ReadonlyArray<{ namespace: string; why: string }> = [{ namespace: "foxhound", why: "a payments product" }];

// A job that asks the driver for blast radius is risky however it is titled.
const HIGH_RISK_FLAGS = new Set(["can_merge", "can_direct_write", "can_dispatch", "can_write_workflows", "can_touch_protected", "money_paths"]);

export interface Risk {
  level: "high" | "routine" | "unread";
  reasons: string[];
  // What was read, so "routine" over nothing cannot pass for "routine over a PR's files".
  files_read: number;
}

/** Risk before a pull request exists, from what the job says about itself: its
 *  namespace, the flags it requires and whether it already needs a human. */
export function riskFromJob(job: { namespace: string; required_flags?: readonly string[]; gate_required?: boolean }): Risk {
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

// Deleted lines in one change above which the work is risky however the files are named.
export const DELETION_LINES_HIGH = 300;
const BACKUP_PATH = /(^|\/)(backups?|restore[-_a-z]*|dump[-_a-z]*)(\/|[-_.]|$)/i;

/** Risk once a pull request exists, from its changed files: the money paths and the
 *  refused paths that auto-merge already names, plus deletions and backups. A rename is
 *  judged under both names. No files is "unread", never "routine". */
export function riskOf(files: readonly ChangedFile[]): Risk {
  if (files.length === 0) return { level: "unread", reasons: ["no changed files were read"], files_read: 0 };
  const reasons = new Set<string>();
  let deleted = 0;
  for (const file of files) {
    for (const path of file.previous_filename ? [file.previous_filename, file.filename] : [file.filename]) {
      if (isMoneyPath(path)) reasons.add(`${path} is a billing or payment path`);
      const refused = AUTO_MERGE_REFUSED_PATHS.find(({ pattern }) => pattern.test(path));
      if (refused) reasons.add(`${path} is ${refused.why}`);
      if (BACKUP_PATH.test(path)) reasons.add(`${path} is a backup or restore path`);
    }
    if (file.status === "removed") reasons.add(`${file.filename} is deleted`);
    deleted += file.deletions ?? 0;
  }
  if (deleted >= DELETION_LINES_HIGH) reasons.add(`${deleted} lines are deleted, at or over ${DELETION_LINES_HIGH}`);
  return { level: reasons.size ? "high" : "routine", reasons: [...reasons].slice(0, 12), files_read: files.length };
}

// WORTH A REVIEWER (D5, Dustin 2026-10-09, option b). riskOf stays as it is: it routes
// models, and for that a dependency bump or a backup document is reason enough for the
// stronger model. It is too broad to decide where a second reader of the diff earns
// its cost: over the last 100 merged capsid PRs it flagged about 7 in 10, mostly
// lockfile and package.json bumps, backup docs and a deleted screenshot. This narrower
// test asks one question: does the change edit code that enforces something, where a
// subtle mistake ships quietly? Nothing calls it yet. The advisory reviewer that would
// is the seat's decision, after this measurement.
//
// Only code is judged. A document, an image, a test, a lockfile or a JSON manifest is
// never the reason on its own: a reviewer reading a version bump or a prose edit adds
// little that CI and the seat do not already see.
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql|sh)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const TEST_FILE = /(^|\/)(test|tests|test-integration|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

// The sources that hold this repo's invariants and credentials but are not on auto-merge's
// refused list, because a green PR there may still merge (CLAUDE.md, rules 3 to 5, and the
// login and key paths). The refused list covers the judges; this covers what they guard.
const GUARD_SOURCES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/store-guards\.ts$/i, why: "the snapshot and audit guard every overwrite and delete runs through" },
  { pattern: /^src\/tools\/repo\.ts$/i, why: "guardedWrite, the one gate on repo mutations" },
  { pattern: /^src\/tools\/docs\.ts$/i, why: "pathMutation, the only way a path changes" },
  { pattern: /^src\/(access-jwt|access-login|ops-session-auth|portal-auth)\.ts$/i, why: "a login or session check" },
  { pattern: /^src\/(runner-key|job-signing)\.ts$/i, why: "a key or a signature" },
  { pattern: /^src\/agents(-admin)?\.ts$/i, why: "the minting and grants of agent credentials" },
];

export interface ReviewWorthiness {
  level: "worth" | "skip" | "unread";
  reasons: string[];
  files_read: number;
}

/** Whether a pull request's diff is worth a second reader: code that is money, a judge
 *  on auto-merge's refused list, a guard or credential source, a migration, a workflow,
 *  or backup and restore code. A rename is judged under both names. No files is
 *  "unread", never "skip". Narrower than riskOf by design; see above. */
export function worthReviewer(files: readonly ChangedFile[]): ReviewWorthiness {
  if (files.length === 0) return { level: "unread", reasons: ["no changed files were read"], files_read: 0 };
  const reasons = new Set<string>();
  for (const file of files) {
    for (const path of file.previous_filename ? [file.previous_filename, file.filename] : [file.filename]) {
      const workflow = WORKFLOW_FILE.test(path);
      if (!workflow && (!CODE_FILE.test(path) || TEST_FILE.test(path))) continue;
      if (workflow) {
        reasons.add(`${path} is a workflow, which holds CI's permissions and secrets`);
        continue;
      }
      if (isMoneyPath(path)) reasons.add(`${path} is billing or payment code`);
      const refused = AUTO_MERGE_REFUSED_PATHS.find(({ pattern }) => pattern.test(path));
      if (refused) reasons.add(`${path} is ${refused.why}`);
      const guard = GUARD_SOURCES.find(({ pattern }) => pattern.test(path));
      if (guard) reasons.add(`${path} is ${guard.why}`);
      // The Worker's and the scripts' backup code, not the Portal's Backups view.
      if (BACKUP_PATH.test(path) && /^(src|scripts)\//i.test(path)) reasons.add(`${path} is backup or restore code`);
    }
  }
  return { level: reasons.size ? "worth" : "skip", reasons: [...reasons].slice(0, 12), files_read: files.length };
}

// THE RULES, as data. First match wins; a high risk comes first, so a routine kind with a
// risky shape is upgraded rather than left on the cheap model.
export interface RoutingRule {
  when: { risk?: "high"; kind?: JobKind };
  model: RoutedModel;
  effort: Effort;
  why: string;
}

export const ROUTING_RULES: readonly RoutingRule[] = [
  { when: { risk: "high" }, model: "opus", effort: "high", why: "risky work gets the strongest model" },
  { when: { kind: "design" }, model: "opus", effort: "high", why: "design is judgment, not execution" },
  { when: { kind: "security" }, model: "opus", effort: "high", why: "a security change is read as an attacker would" },
  { when: { kind: "build" }, model: "opusplan", effort: "high", why: "a large build: Opus plans, Sonnet executes" },
  { when: { kind: "watcher" }, model: "sonnet", effort: "medium", why: "a watcher finding is routine maintenance" },
  { when: { kind: "maintenance" }, model: "sonnet", effort: "medium", why: "routine maintenance" },
  { when: { kind: "docs" }, model: "sonnet", effort: "low", why: "documentation" },
  { when: { kind: "mechanical" }, model: "haiku", effort: "low", why: "a mechanical edit" },
  { when: {}, model: "opusplan", effort: "medium", why: "no rule names this kind, so the repo default" },
];

export interface Routing {
  kind: JobKind;
  kind_source: KindVerdict["source"];
  model: RoutedModel;
  effort: Effort;
  risk: Risk["level"];
  // One line, stored with the job: why this model, under which rules.
  reason: string;
  rules_version: number;
}

// A model a job names for itself, "model: opus" on a line of its own in the body. Read
// from the body's own text, which the signature covers, so it is the poster's word.
const NAMED_MODEL = /^\s*model\s*[:=]\s*(haiku|sonnet|opusplan|opus)\s*$/im;

export function routeJob(job: {
  title: string;
  body?: string | null;
  namespace: string;
  posted_by: string;
  kind?: string | null;
  required_flags?: readonly string[];
  gate_required?: boolean;
  // A pull request's risk, where one was read (claim on a job that already carries a PR).
  pr_risk?: Risk | null;
}): Routing {
  const k = deriveKind(job);
  const fromJob = riskFromJob(job);
  const risk: Risk = job.pr_risk && job.pr_risk.level === "high" ? job.pr_risk : fromJob;
  const named = job.body ? NAMED_MODEL.exec(job.body)?.[1]?.toLowerCase() : undefined;
  const rule = ROUTING_RULES.find((r) => (r.when.risk ? risk.level === r.when.risk : r.when.kind ? r.when.kind === k.kind : true))!;
  const model = (named as RoutedModel | undefined) ?? rule.model;
  const why = named
    ? `the job names ${named}`
    : risk.level === "high" && rule.when.risk
      ? `${rule.why}: ${risk.reasons.join("; ")}`
      : `${rule.why} (kind ${k.kind}, ${k.source})`;
  return {
    kind: k.kind,
    kind_source: k.source,
    model,
    effort: rule.effort,
    risk: risk.level,
    reason: why.slice(0, 300),
    rules_version: ROUTING_RULES_VERSION,
  };
}

// LEARNING.

// A cell (kind, model) is read only from this many outcomes. Below it a rate is noise: a
// single merged job reads as 100 percent.
export const MIN_SAMPLE = 10;
// A model whose merged-with-green rate for a kind is under this, with enough outcomes,
// is a reason to propose a more capable one.
export const RATE_FLOOR = 0.6;
// How much better a more capable model's rate must be before it is proposed.
export const RATE_GAIN = 0.1;

export interface OutcomeFact {
  kind: string | null;
  // The model that did the work (the claim's model_id, reduced to an alias) or, where the
  // session reported none, the one chosen.
  model: string | null;
  prs_merged: number | null;
  ci_green: number | null;
  corrections: number | null;
  cost_usd: number | null;
  tokens: number | null;
}

export interface Cell {
  kind: string;
  model: string;
  n: number;
  // Jobs with a verified merge and green CI, over n.
  merged_green: number;
  rate: number;
  corrections_mean: number | null;
  cost_mean_usd: number | null;
  cost_n: number;
  // Below MIN_SAMPLE: shown, never acted on.
  enough: boolean;
}

/** The alias a model id reduces to: "claude-opus-5-5" and "opus" are both opus. A
 *  model it does not recognise is kept as reported, so it shows as its own cell. */
export function modelAlias(id: string | null): string | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  for (const alias of ["opusplan", "opus", "sonnet", "haiku"] as const) if (lower.includes(alias)) return alias;
  return lower.slice(0, 64);
}

export function cellsOf(facts: readonly OutcomeFact[]): Cell[] {
  const groups = new Map<string, OutcomeFact[]>();
  for (const f of facts) {
    const model = modelAlias(f.model);
    if (!f.kind || !model) continue;
    const key = `${f.kind}\u0000${model}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...f, model }]);
  }
  const cells: Cell[] = [];
  for (const [key, rows] of groups) {
    const [kind, model] = key.split("\u0000") as [string, string];
    const good = rows.filter((r) => (r.prs_merged ?? 0) >= 1 && r.ci_green === 1).length;
    const corr = rows.filter((r) => r.corrections !== null);
    const costed = rows.filter((r) => r.cost_usd !== null);
    cells.push({
      kind,
      model,
      n: rows.length,
      merged_green: good,
      rate: good / rows.length,
      corrections_mean: corr.length ? corr.reduce((s, r) => s + (r.corrections ?? 0), 0) / corr.length : null,
      cost_mean_usd: costed.length ? costed.reduce((s, r) => s + (r.cost_usd ?? 0), 0) / costed.length : null,
      cost_n: costed.length,
      enough: rows.length >= MIN_SAMPLE,
    });
  }
  return cells.sort((a, b) => a.kind.localeCompare(b.kind) || MODELS.indexOf(a.model as RoutedModel) - MODELS.indexOf(b.model as RoutedModel));
}

export interface Proposal {
  kind: string;
  from: string;
  to: string;
  why: string;
}

const rank = (model: string): number => MODELS.indexOf(model as RoutedModel);

/** Rule changes the evidence supports, never applied: the seat approves each (the rules
 *  are code). Only cells with MIN_SAMPLE outcomes count. A cheaper model is proposed when
 *  it did as well as the current one; a more capable one when the current one is under the
 *  floor and the other is clearly better. The current model for a kind is the one its
 *  routine rule names. */
export function proposeRuleChanges(cells: readonly Cell[]): Proposal[] {
  const out: Proposal[] = [];
  for (const kind of JOB_KINDS) {
    const rule = ROUTING_RULES.find((r) => r.when.kind === kind) ?? ROUTING_RULES[ROUTING_RULES.length - 1]!;
    const current = cells.find((c) => c.kind === kind && c.model === rule.model && c.enough);
    if (!current) continue;
    const others = cells.filter((c) => c.kind === kind && c.model !== rule.model && c.enough);
    const cheaper = others.filter((c) => rank(c.model) >= 0 && rank(c.model) < rank(rule.model) && c.rate >= current.rate).sort((a, b) => rank(a.model) - rank(b.model))[0];
    if (cheaper) {
      out.push({ kind, from: rule.model, to: cheaper.model, why: `${cheaper.model} merged green ${cheaper.merged_green}/${cheaper.n} against ${current.merged_green}/${current.n} on ${rule.model}` });
      continue;
    }
    const stronger = others.filter((c) => rank(c.model) > rank(rule.model) && c.rate >= current.rate + RATE_GAIN).sort((a, b) => b.rate - a.rate)[0];
    if (current.rate < RATE_FLOOR && stronger) {
      out.push({ kind, from: rule.model, to: stronger.model, why: `${rule.model} merged green ${current.merged_green}/${current.n}, under ${RATE_FLOOR * 100} percent, and ${stronger.model} ${stronger.merged_green}/${stronger.n}` });
    }
  }
  return out;
}
