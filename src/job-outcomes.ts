import type { Env } from "./env";
import { ciStatus } from "./github";
import { ghFetch, parsePrUrl, resolveRepo } from "./github/client";
import type { JobRow } from "./jobs-schema";
import type { RunSignal } from "./skills-lifecycle";

// One outcome row per finished job, written once, carrying counts.
//
// The Worker never stores a driver's count for something it could have checked. This
// Worker holds a GitHub App token that reaches every repo in the portfolio, so for
// anything that ended in a pull request the authority is GitHub and the driver's
// number is an opinion. Where a check ran, the stored number is GitHub's and the field
// is marked verified; where it could not run, the driver's number is stored and marked
// unverified. A reader can always tell which.
//
// Null is not zero: a field nobody reported is null, a field counted and found empty
// is 0. Collapsing the two would make "no driver reports test counts"
// indistinguishable from "no driver adds tests".

export const OUTCOME_RESULT_KINDS = ["pr", "doc", "none"] as const;
export type OutcomeResultKind = (typeof OUTCOME_RESULT_KINDS)[number];

// The fields a driver may report. An omitted field stays null in the row.
export interface JobEvidence {
  // Pull request URLs: the only field that unlocks verification.
  prs?: string[];
  commits?: number;
  files_changed?: number;
  tests_added?: number;
}

// Which fields the Worker checked itself, stored as JSON on the row, written out in full.
export interface VerifiedFields {
  prs_opened: boolean;
  prs_merged: boolean;
  commits: boolean;
  files_changed: boolean;
  ci_green: boolean;
}

export interface JobOutcomeRow {
  job_id: string;
  agent: string;
  namespace: string;
  prs_opened: number | null;
  prs_merged: number | null;
  commits: number | null;
  files_changed: number | null;
  tests_added: number | null;
  ci_green: number | null;
  blocked_count: number;
  resumed_count: number;
  duration_minutes: number | null;
  result_kind: OutcomeResultKind;
  verified: string;
  // The skills this job was offered and used, as JSON arrays. NULL, not an empty
  // array, when the job named none: improve_status sums json_array_length and SUM
  // skips NULL, so such a job counts toward neither total.
  skill_ids_offered: string | null;
  skill_ids_used: string | null;
  recorded_at: string;
  // What the job's Claude Code sessions reported by OpenTelemetry (migrations/0025),
  // summed from session_usage when the row is written. NULL when no telemetry for the
  // job reached Capsid, never 0.
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  active_seconds: number | null;
}

// A job's telemetry totals, as the outcome row stores them.
export type JobUsage = Pick<
  JobOutcomeRow,
  "cost_usd" | "tokens_input" | "tokens_output" | "tokens_cache_read" | "tokens_cache_creation" | "active_seconds"
>;

const NO_USAGE: JobUsage = {
  cost_usd: null,
  tokens_input: null,
  tokens_output: null,
  tokens_cache_read: null,
  tokens_cache_creation: null,
  active_seconds: null,
};

const TOKEN_COLUMN: Record<string, "tokens_input" | "tokens_output" | "tokens_cache_read" | "tokens_cache_creation"> = {
  input: "tokens_input",
  output: "tokens_output",
  cacheRead: "tokens_cache_read",
  cacheCreation: "tokens_cache_creation",
};

/**
 * The per-job totals from session_usage rows (metric, kind, total), which is what
 * readJobUsage selects. Per metric family: a family with no row at all stays NULL
 * (nothing was reported); once a family has a row, a type it lacks is 0, because
 * Claude Code exports no point for a counter that did not move.
 */
export function usageFromTotals(rows: ReadonlyArray<{ metric: string; kind: string; total: number | null }>): JobUsage {
  const usage: JobUsage = { ...NO_USAGE };
  const families = new Set(rows.map((r) => r.metric));
  if (families.has("claude_code.cost.usage")) usage.cost_usd = 0;
  if (families.has("claude_code.token.usage")) {
    for (const column of Object.values(TOKEN_COLUMN)) usage[column] = 0;
  }
  if (families.has("claude_code.active_time.total")) usage.active_seconds = 0;
  for (const row of rows) {
    const total = Number(row.total ?? 0);
    if (!Number.isFinite(total)) continue;
    if (row.metric === "claude_code.cost.usage") usage.cost_usd = (usage.cost_usd ?? 0) + total;
    else if (row.metric === "claude_code.active_time.total") usage.active_seconds = (usage.active_seconds ?? 0) + total;
    else if (row.metric === "claude_code.token.usage" && Object.hasOwn(TOKEN_COLUMN, row.kind)) {
      const column = TOKEN_COLUMN[row.kind];
      usage[column] = (usage[column] ?? 0) + total;
    }
  }
  // The token columns are INTEGER.
  for (const column of Object.values(TOKEN_COLUMN)) {
    const value = usage[column];
    if (value !== null) usage[column] = Math.round(value);
  }
  return usage;
}

/** The job's telemetry totals from session_usage (src/ops-otlp.ts writes it). */
export async function readJobUsage(db: D1Database, jobId: string): Promise<JobUsage> {
  const { results } = await db
    .prepare(
      `SELECT metric, kind, SUM(value) AS total FROM session_usage
       WHERE job_id = ?1 AND metric IN ('claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.active_time.total')
       GROUP BY metric, kind`
    )
    .bind(jobId)
    .all<{ metric: string; kind: string; total: number | null }>();
  return usageFromTotals(results ?? []);
}

/** The skills a driver reports for one finished job. Names only; the credit comes
 *  from what the Worker verified on GitHub, never from this. */
export interface JobSkills {
  offered?: readonly string[];
  used?: readonly string[];
}

const skillColumn = (ids: readonly string[] | undefined): string | null =>
  ids && ids.length > 0 ? JSON.stringify([...ids]) : null;

/**
 * What one finished job says about the skills it used, as a signal attribute() reads.
 * The direction comes only from what this Worker read off GitHub: every named pull
 * request merged, and CI green on the head of the last one. An unverified job is
 * "environment-failure", which earns nothing either way, so a GitHub outage cannot
 * retire a skill.
 */
export function signalFor(verdict: EvidenceVerdict): RunSignal {
  // prs_opened is verified only when every named pull request was read. A partly read
  // run is not judged: a pull request the Worker could not read is never counted as a
  // loss, and never as a win either.
  const checked = verdict.verified.prs_opened && verdict.verified.prs_merged && verdict.verified.ci_green;
  if (!checked || verdict.prs_opened === null || verdict.prs_opened === 0) return "environment-failure";
  const allMerged = verdict.prs_merged !== null && verdict.prs_merged === verdict.prs_opened;
  return allMerged && verdict.ci_green === 1 ? "verified-success" : "verified-failure";
}

/** signalFor over a stored outcome row, for the evaluation cycle, which reads rows
 *  rather than live verdicts. It builds the verdict fields the row kept and calls
 *  signalFor, so the two cannot disagree. A verified column that does not parse
 *  verified nothing, which earns no credit either way. */
export function signalForRow(row: Pick<JobOutcomeRow, "prs_opened" | "prs_merged" | "ci_green" | "verified">): RunSignal {
  let verified: VerifiedFields = NOTHING_VERIFIED;
  try {
    const parsed = JSON.parse(row.verified) as Partial<VerifiedFields>;
    verified = { ...NOTHING_VERIFIED, ...parsed };
  } catch {
    verified = NOTHING_VERIFIED;
  }
  return signalFor({
    prs_opened: row.prs_opened,
    prs_merged: row.prs_merged,
    ci_green: row.ci_green,
    commits: null,
    files_changed: null,
    tests_added: null,
    verified,
    notes: [],
  });
}

const NOTHING_VERIFIED: VerifiedFields = {
  prs_opened: false,
  prs_merged: false,
  commits: false,
  files_changed: false,
  ci_green: false,
};

// Derived from result_ref, not declared: `resultRef` in src/limits.ts admits only a
// document path or an https URL.
export function resultKindOf(resultRef: string | null | undefined): OutcomeResultKind {
  if (!resultRef) return "none";
  return /^https:\/\//i.test(resultRef) ? "pr" : "doc";
}

// Whole minutes from the first claim, including time blocked at a gate; resume does
// not reset claimed_at (migrations/0011's comment describes an earlier rule). A job the
// lease sweep requeued is measured from its new claim. null with no claim timestamp,
// and null rather than negative if the clocks disagree.
export function durationMinutes(claimedAt: string | null, now: Date): number | null {
  if (!claimedAt) return null;
  const started = Date.parse(claimedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = now.getTime() - started;
  if (elapsed < 0) return null;
  return Math.round(elapsed / 60000);
}

interface PrFacts {
  merged: boolean;
  commits: number;
  changed_files: number;
  head_sha: string;
  // The repo this pull request is on, resolved through the namespace mapping, so the
  // CI lookup asks that repo and not the namespace primary.
  repo: string;
  // Which pull request answered at this number: GitHub's global node id and when it was
  // opened. A recreated or transferred repo reuses numbers, so a URL alone does not say
  // which pull request an outcome named (src/outcome-prs.ts). Null when GitHub omitted it.
  node_id: string | null;
  created_at: string | null;
}

export interface EvidenceVerdict {
  prs_opened: number | null;
  prs_merged: number | null;
  commits: number | null;
  files_changed: number | null;
  tests_added: number | null;
  ci_green: number | null;
  verified: VerifiedFields;
  // Every verification that could not run, and why.
  notes: string[];
  // Each named pull request's merge state as GitHub reported it, keyed by URL. A URL
  // the Worker could not read is absent, never false. Written to job_outcome_prs at
  // complete time, so the row says which pull requests were verified.
  pr_states?: Record<string, boolean>;
  // Each pull request read, by URL: which one it was, pinned on its join row so a later
  // read of the same URL can tell whether the number still names it.
  pr_identity?: Record<string, { node_id: string | null; created_at: string | null }>;
  // What GitHub itself said, kept apart from the fields above, which mix it with the
  // driver's numbers. job_evaluations (src/job-claims.ts) sets these beside the claim,
  // so a check that disagreed with the driver is recorded as a disagreement rather
  // than as the one number job_outcomes keeps. Null wherever the Worker did not read
  // it; merged has an entry only for a pull request that was read.
  github?: GitHubFacts;
  // The driver's numbers as sent, before any of them was replaced by GitHub's.
  reported?: { prs: string[] | null; commits: number | null; files_changed: number | null; tests_added: number | null };
}

export interface GitHubFacts {
  merged: Record<string, boolean>;
  // Sums over every named pull request, null unless every one was read: a sum over
  // some of them is not the job's total.
  commits: number | null;
  files_changed: number | null;
  // CI on the last named pull request's head, 1 or 0, null when not answered.
  ci_green: number | null;
}

export async function prFacts(env: Env, namespace: string, url: string): Promise<PrFacts | string> {
  const parsed = parsePrUrl(url);
  if (!parsed) return `${url} is not a GitHub pull request URL, so nothing could be verified about it`;
  const { owner, repo, number } = parsed;
  // Resolved through the namespace mapping, the authorization boundary, so the
  // outcome recorder cannot read a repo the namespace does not map.
  let resolved;
  try {
    resolved = await resolveRepo(env, namespace, `${owner}/${repo}`);
  } catch (err) {
    return `${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  // Caught too: verifyEvidence promises its callers a note, never a throw.
  let pr: { merged?: boolean; commits?: number; changed_files?: number; head?: { sha?: string }; node_id?: string; created_at?: string };
  try {
    const resp = await ghFetch(env, resolved.owner, resolved.repo, `/repos/${resolved.owner}/${resolved.repo}/pulls/${number}`);
    if (!resp.ok) return `${url}: GitHub answered ${resp.status}, so its state could not be read`;
    pr = (await resp.json()) as typeof pr;
  } catch (err) {
    return `${url}: GitHub could not be read (${err instanceof Error ? err.message : String(err)})`;
  }
  return {
    merged: pr.merged === true,
    commits: typeof pr.commits === "number" ? pr.commits : 0,
    changed_files: typeof pr.changed_files === "number" ? pr.changed_files : 0,
    head_sha: pr.head?.sha ?? "",
    repo: resolved.full,
    node_id: typeof pr.node_id === "string" && pr.node_id ? pr.node_id : null,
    created_at: typeof pr.created_at === "string" && pr.created_at ? pr.created_at : null,
  };
}

// CI is green only when every run has finished and none failed. No runs, or a run
// still going, is null and unverified: not answered yet is not failed. `skipped` and
// `neutral` do not fail, since a paths filter that excluded the change did not judge it.
const NOT_A_FAILURE = new Set(["success", "skipped", "neutral"]);

async function ciGreenForSha(env: Env, namespace: string, sha: string, repo: string): Promise<{ green: boolean | null; note?: string }> {
  if (!sha) return { green: null, note: "the pull request carried no head sha, so CI could not be looked up" };
  let status;
  try {
    // The repo the pull request is on, not the namespace primary.
    status = await ciStatus(env, namespace, repo, { ref: sha, limit: 20 });
  } catch (err) {
    return { green: null, note: `CI could not be read for ${sha.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const runs = status.runs ?? [];
  if (runs.length === 0) return { green: null, note: `no workflow runs for ${sha.slice(0, 7)}, so CI has nothing to say about it` };
  if (runs.some((r) => r.status !== "completed")) {
    return { green: null, note: `CI for ${sha.slice(0, 7)} has not finished, so it is neither green nor red yet` };
  }
  return { green: runs.every((r) => NOT_A_FAILURE.has(r.conclusion ?? "")) };
}

// Evidence arrives as an object or as a JSON string, because some clients flatten an
// object argument to a string, and a client with a stale cached schema may refuse
// the object. A string that does not parse is refused, not ignored, so evidence is
// never silently discarded.
export type EvidenceInput = JobEvidence | string | undefined;

export function parseEvidence(input: EvidenceInput): { evidence: JobEvidence | undefined } | { error: string } {
  if (input === undefined) return { evidence: undefined };
  if (typeof input !== "string") return { evidence: input };
  const text = input.trim();
  if (text.length === 0) return { evidence: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `evidence was sent as a string that is not JSON: ${text.slice(0, 120)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "evidence parsed to something that is not an object, so there are no fields to read." };
  }
  const row = parsed as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const value = row[key];
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    // Dropped rather than coerced: a stored 0 would read as counted and found none.
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const prs = Array.isArray(row.prs) ? row.prs.filter((p): p is string => typeof p === "string") : undefined;
  return {
    evidence: {
      ...(prs && prs.length > 0 ? { prs } : {}),
      ...(num("commits") !== undefined ? { commits: num("commits") } : {}),
      ...(num("files_changed") !== undefined ? { files_changed: num("files_changed") } : {}),
      ...(num("tests_added") !== undefined ? { tests_added: num("tests_added") } : {}),
    },
  };
}

// The pull requests a finished job names: evidence.prs, plus the job's result_ref when it
// is a pull request URL. A session that sends only result_ref (the seat closing a job it
// took, or a driver that left evidence out) named its pull request all the same, and
// GitHub, not the sender, is the authority on it (job_d5262df1dc32). Deduplicated, in
// order, so the pull request named twice is read and counted once.
export function namedPrUrls(evidence: JobEvidence | undefined, resultRef: string | null | undefined): string[] {
  const urls: string[] = [];
  for (const url of [...(evidence?.prs ?? []), ...(parsePrUrl(resultRef) ? [resultRef!.trim()] : [])]) {
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Best effort, and it never fails the job: with GitHub unreachable the outcome records
// the driver's own numbers, marked unverified, with a note saying why.
//
// resultRef is the job's result_ref. `reported` stays what the evidence said, so the
// record of what the driver sent is not changed by what the Worker also read.
export async function verifyEvidence(
  env: Env,
  namespace: string,
  evidence: JobEvidence | undefined,
  resultRef?: string | null
): Promise<EvidenceVerdict> {
  const reported = {
    commits: evidence?.commits ?? null,
    files_changed: evidence?.files_changed ?? null,
    tests_added: evidence?.tests_added ?? null,
  };
  const urls = namedPrUrls(evidence, resultRef);
  const github: GitHubFacts = { merged: {}, commits: null, files_changed: null, ci_green: null };
  const verdict: EvidenceVerdict = {
    prs_opened: urls.length > 0 ? urls.length : null,
    prs_merged: null,
    ...reported,
    ci_green: null,
    verified: { ...NOTHING_VERIFIED },
    notes: [],
    github,
    reported: { prs: evidence?.prs && evidence.prs.length > 0 ? [...evidence.prs] : null, ...reported },
  };
  if (urls.length === 0) return verdict;

  const facts: PrFacts[] = [];
  const read = new Map<string, PrFacts>();
  for (const url of urls) {
    const one = await prFacts(env, namespace, url);
    if (typeof one === "string") verdict.notes.push(one);
    else {
      facts.push(one);
      read.set(url, one);
    }
  }
  verdict.pr_states = Object.fromEntries([...read].map(([url, f]) => [url, f.merged]));
  verdict.pr_identity = Object.fromEntries([...read].map(([url, f]) => [url, { node_id: f.node_id, created_at: f.created_at }]));
  github.merged = { ...verdict.pr_states };

  // A partly read list keeps what was read. prs_merged counts the pull requests that
  // were read and is marked verified, as the re-verification sweep already does.
  // prs_opened stays the number named and UNVERIFIED, so no reader takes the merged
  // count for a total: the agent record's merge rate reads only rows whose prs_opened
  // is verified, and signalFor leaves the run unjudged. Commits and files stay the
  // driver's, since a sum over some of the pull requests is not the job's total.
  if (facts.length !== urls.length) {
    if (facts.length > 0) {
      verdict.prs_merged = facts.filter((f) => f.merged).length;
      verdict.verified.prs_merged = true;
    }
    verdict.notes.push(
      `${facts.length} of ${urls.length} named pull requests could be read. prs_merged counts the ${facts.length} read and is verified; prs_opened, commits and files_changed stay the driver's and unverified, and the run is not judged.`
    );
    // CI on the last named pull request, when that one was read.
    const lastUrl = urls[urls.length - 1];
    const lastRead = read.get(lastUrl);
    if (!lastRead) {
      verdict.notes.push(`the last named pull request (${lastUrl}) could not be read, so CI was not looked up`);
      return verdict;
    }
    const partialCi = await ciGreenForSha(env, namespace, lastRead.head_sha, lastRead.repo);
    if (partialCi.note) verdict.notes.push(partialCi.note);
    if (partialCi.green !== null) {
      verdict.ci_green = partialCi.green ? 1 : 0;
      verdict.verified.ci_green = true;
      github.ci_green = verdict.ci_green;
    }
    return verdict;
  }

  verdict.prs_opened = facts.length;
  verdict.prs_merged = facts.filter((f) => f.merged).length;
  verdict.commits = facts.reduce((total, f) => total + f.commits, 0);
  verdict.files_changed = facts.reduce((total, f) => total + f.changed_files, 0);
  verdict.verified.prs_opened = true;
  verdict.verified.prs_merged = true;
  verdict.verified.commits = true;
  verdict.verified.files_changed = true;
  github.commits = verdict.commits;
  github.files_changed = verdict.files_changed;

  // CI on the last pull request's head, the one a driver opens at the end of its work.
  const last = facts[facts.length - 1];
  const ci = await ciGreenForSha(env, namespace, last.head_sha, last.repo);
  if (ci.note) verdict.notes.push(ci.note);
  if (ci.green !== null) {
    verdict.ci_green = ci.green ? 1 : 0;
    verdict.verified.ci_green = true;
    github.ci_green = verdict.ci_green;
  }
  return verdict;
}

// usage: the job's telemetry totals (readJobUsage). Omitted is no telemetry: NULL.
export function outcomeFrom(job: JobRow, verdict: EvidenceVerdict, now: Date, skills?: JobSkills, usage: JobUsage = NO_USAGE): JobOutcomeRow {
  return {
    job_id: job.id,
    // Copied, not joined, because a later lease expiry clears claimed_by.
    // "unattributed" only keeps the NOT NULL column satisfied.
    agent: job.claimed_by ?? "unattributed",
    namespace: job.namespace,
    prs_opened: verdict.prs_opened,
    prs_merged: verdict.prs_merged,
    commits: verdict.commits,
    files_changed: verdict.files_changed,
    tests_added: verdict.tests_added,
    ci_green: verdict.ci_green,
    blocked_count: job.blocked_count,
    resumed_count: job.resumed_count,
    duration_minutes: durationMinutes(job.claimed_at, now),
    result_kind: resultKindOf(job.result_ref),
    verified: JSON.stringify(verdict.verified),
    skill_ids_offered: skillColumn(skills?.offered),
    skill_ids_used: skillColumn(skills?.used),
    recorded_at: now.toISOString(),
    cost_usd: usage.cost_usd,
    tokens_input: usage.tokens_input,
    tokens_output: usage.tokens_output,
    tokens_cache_read: usage.tokens_cache_read,
    tokens_cache_creation: usage.tokens_cache_creation,
    active_seconds: usage.active_seconds,
  };
}

// ON CONFLICT DO NOTHING: the first record of a job stands, and a second terminal
// transition neither rewrites it nor aborts its own batch.
export function outcomeStatement(db: D1Database, row: JobOutcomeRow) {
  return db
    .prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, commits, files_changed,
         tests_added, ci_green, blocked_count, resumed_count, duration_minutes, result_kind, verified,
         skill_ids_offered, skill_ids_used, recorded_at, cost_usd, tokens_input, tokens_output,
         tokens_cache_read, tokens_cache_creation, active_seconds)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
       ON CONFLICT(job_id) DO NOTHING`
    )
    .bind(
      row.job_id,
      row.agent,
      row.namespace,
      row.prs_opened,
      row.prs_merged,
      row.commits,
      row.files_changed,
      row.tests_added,
      row.ci_green,
      row.blocked_count,
      row.resumed_count,
      row.duration_minutes,
      row.result_kind,
      row.verified,
      row.skill_ids_offered,
      row.skill_ids_used,
      row.recorded_at,
      row.cost_usd,
      row.tokens_input,
      row.tokens_output,
      row.tokens_cache_read,
      row.tokens_cache_creation,
      row.active_seconds
    );
}
