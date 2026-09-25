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
  const checked = verdict.verified.prs_merged && verdict.verified.ci_green;
  if (!checked || verdict.prs_opened === null || verdict.prs_opened === 0) return "environment-failure";
  const allMerged = verdict.prs_merged !== null && verdict.prs_merged === verdict.prs_opened;
  return allMerged && verdict.ci_green === 1 ? "verified-success" : "verified-failure";
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
  let pr: { merged?: boolean; commits?: number; changed_files?: number; head?: { sha?: string } };
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

// Best effort, and it never fails the job: with GitHub unreachable the outcome records
// the driver's own numbers, marked unverified, with a note saying why.
export async function verifyEvidence(
  env: Env,
  namespace: string,
  evidence: JobEvidence | undefined
): Promise<EvidenceVerdict> {
  const reported = {
    commits: evidence?.commits ?? null,
    files_changed: evidence?.files_changed ?? null,
    tests_added: evidence?.tests_added ?? null,
  };
  const urls = evidence?.prs ?? [];
  const verdict: EvidenceVerdict = {
    prs_opened: urls.length > 0 ? urls.length : null,
    prs_merged: null,
    ...reported,
    ci_green: null,
    verified: { ...NOTHING_VERIFIED },
    notes: [],
  };
  if (urls.length === 0) return verdict;

  const facts: PrFacts[] = [];
  for (const url of urls) {
    const one = await prFacts(env, namespace, url);
    if (typeof one === "string") verdict.notes.push(one);
    else facts.push(one);
  }

  // Partial verification is not verification: a count over the subset that resolved
  // would be a smaller number presented as a total.
  if (facts.length !== urls.length) {
    verdict.notes.push(
      `${facts.length} of ${urls.length} named pull requests could be read, so the counts below are the driver's own and are marked unverified.`
    );
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

  // CI on the last pull request's head, the one a driver opens at the end of its work.
  const last = facts[facts.length - 1];
  const ci = await ciGreenForSha(env, namespace, last.head_sha, last.repo);
  if (ci.note) verdict.notes.push(ci.note);
  if (ci.green !== null) {
    verdict.ci_green = ci.green ? 1 : 0;
    verdict.verified.ci_green = true;
  }
  return verdict;
}

export function outcomeFrom(job: JobRow, verdict: EvidenceVerdict, now: Date, skills?: JobSkills): JobOutcomeRow {
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
  };
}

// ON CONFLICT DO NOTHING: the first record of a job stands, and a second terminal
// transition neither rewrites it nor aborts its own batch.
export function outcomeStatement(db: D1Database, row: JobOutcomeRow) {
  return db
    .prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, commits, files_changed,
         tests_added, ci_green, blocked_count, resumed_count, duration_minutes, result_kind, verified,
         skill_ids_offered, skill_ids_used, recorded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
      row.recorded_at
    );
}
