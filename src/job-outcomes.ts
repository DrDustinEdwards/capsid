import type { Env } from "./env";
import { ciStatus } from "./github";
import { parsePrUrl } from "@dustinedwards/site-runtime/github";
import { ghFetch, resolveRepo } from "./github/client";
import type { JobRow } from "./jobs-schema";
import { MINUTE_MS } from "./time";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// One outcome row per finished job, written once. Where the job ended in a pull request GitHub, not the driver, is
// the authority (the Worker's App token reaches every repo): a checked number is GitHub's, marked verified; else the
// driver's, unverified. Null is not zero: unreported is null, counted and found empty is 0.

export const OUTCOME_RESULT_KINDS = ["pr", "doc", "none"] as const;
export type OutcomeResultKind = (typeof OUTCOME_RESULT_KINDS)[number];

export interface JobEvidence {
  prs?: string[];
  commits?: number;
  files_changed?: number;
  tests_added?: number;
}

interface VerifiedFields {
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
  recorded_at: string;
  // Kind, the model Capsid recommended and the one the session reported (0032); NULL where not routed or reported.
  job_kind?: string | null;
  model_chosen?: string | null;
  model_actual?: string | null;
}

const NOTHING_VERIFIED: VerifiedFields = {
  prs_opened: false,
  prs_merged: false,
  commits: false,
  files_changed: false,
  ci_green: false,
};

// Derived from result_ref, which admits only a document path or an https URL.
export function resultKindOf(resultRef: string | null | undefined): OutcomeResultKind {
  if (!resultRef) return "none";
  return /^https:\/\//i.test(resultRef) ? "pr" : "doc";
}

// Whole minutes from the first claim, including gate time; resume does not reset claimed_at (0011's comment is
// stale) and a seat-released job keeps it. null with no claim, and null rather than negative on clock skew.
export function durationMinutes(claimedAt: string | null, now: Date): number | null {
  if (!claimedAt) return null;
  const started = Date.parse(claimedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = now.getTime() - started;
  if (elapsed < 0) return null;
  return Math.round(elapsed / MINUTE_MS);
}

interface PrFacts {
  merged: boolean;
  commits: number;
  changed_files: number;
  head_sha: string;
  // Resolved through the namespace mapping so CI asks that repo, not the namespace primary.
  repo: string;
  // GitHub's node id and open time: a recreated or transferred repo reuses numbers, so a URL alone does not
  // say which PR an outcome named (src/outcome-prs.ts). Null when GitHub omitted it.
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
  notes: string[];
  // Merge state as GitHub reported it, by URL; a URL the Worker could not read is absent, never false.
  pr_states?: Record<string, boolean>;
  // Which PR each URL was, pinned so a later read can tell whether the number still names it.
  pr_identity?: Record<string, { node_id: string | null; created_at: string | null }>;
  // What GitHub itself said, apart from fields that mix in the driver's numbers (job_evaluations sets these).
  github?: GitHubFacts;
  reported?: {
    prs: string[] | null;
    commits: number | null;
    files_changed: number | null;
    tests_added: number | null;
  };
}

export interface GitHubFacts {
  merged: Record<string, boolean>;
  // Null unless every named PR was read: a sum over some is not the total.
  commits: number | null;
  files_changed: number | null;
  ci_green: number | null;
}

export async function prFacts(env: Env, namespace: string, url: string): Promise<PrFacts | string> {
  const parsed = parsePrUrl(url);
  if (!parsed)
    return `${url} is not a GitHub pull request URL, so nothing could be verified about it`;
  const { owner, repo, number } = parsed;
  // Resolved through the namespace mapping, the authorization boundary, so the recorder cannot read an unmapped repo.
  let resolved;
  try {
    resolved = await resolveRepo(env, namespace, `${owner}/${repo}`);
  } catch (err) {
    return `${url}: ${errorMessage(err)}`;
  }
  // Caught too: verifyEvidence promises a note, never a throw.
  let pr: {
    merged?: boolean;
    commits?: number;
    changed_files?: number;
    head?: { sha?: string };
    node_id?: string;
    created_at?: string;
  };
  try {
    const resp = await ghFetch(
      env,
      resolved.owner,
      resolved.repo,
      `/repos/${resolved.owner}/${resolved.repo}/pulls/${number}`,
    );
    if (!resp.ok) return `${url}: GitHub answered ${resp.status}, so its state could not be read`;
    pr = (await resp.json()) as typeof pr;
  } catch (err) {
    return `${url}: GitHub could not be read (${errorMessage(err)})`;
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

// Green only when every run finished and none failed; no runs or one still going is null (not answered is not
// failed). `skipped` and `neutral` do not fail: a paths filter that excluded the change did not judge it.
const NOT_A_FAILURE = new Set(["success", "skipped", "neutral"]);

async function ciGreenForSha(
  env: Env,
  namespace: string,
  sha: string,
  repo: string,
): Promise<{ green: boolean | null; note?: string }> {
  if (!sha)
    return {
      green: null,
      note: "the pull request carried no head sha, so CI could not be looked up",
    };
  let status;
  try {
    status = await ciStatus(env, namespace, repo, { ref: sha, limit: 20 });
  } catch (err) {
    return {
      green: null,
      note: `CI could not be read for ${sha.slice(0, 7)}: ${errorMessage(err)}`,
    };
  }
  const runs = status.runs ?? [];
  if (runs.length === 0)
    return {
      green: null,
      note: `no workflow runs for ${sha.slice(0, 7)}, so CI has nothing to say about it`,
    };
  if (runs.some((r) => r.status !== "completed")) {
    return {
      green: null,
      note: `CI for ${sha.slice(0, 7)} has not finished, so it is neither green nor red yet`,
    };
  }
  return { green: runs.every((r) => NOT_A_FAILURE.has(r.conclusion ?? "")) };
}

// Evidence arrives as an object or JSON string (some clients flatten objects); an unparseable string is refused.
export type EvidenceInput = JobEvidence | string | undefined;

export function parseEvidence(
  input: EvidenceInput,
): { evidence: JobEvidence | undefined } | { error: string } {
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
    return {
      error: "evidence parsed to something that is not an object, so there are no fields to read.",
    };
  }
  const row = parsed as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const value = row[key];
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    // Dropped rather than coerced: a stored 0 would read as counted and found none.
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const prs = Array.isArray(row.prs)
    ? row.prs.filter((p): p is string => typeof p === "string")
    : undefined;
  return {
    evidence: {
      ...(prs && prs.length > 0 ? { prs } : {}),
      ...(num("commits") !== undefined ? { commits: num("commits") } : {}),
      ...(num("files_changed") !== undefined ? { files_changed: num("files_changed") } : {}),
      ...(num("tests_added") !== undefined ? { tests_added: num("tests_added") } : {}),
    },
  };
}

// evidence.prs plus result_ref when it is a PR URL (a session sending only result_ref named its PR all the same). Deduplicated.
export function namedPrUrls(
  evidence: JobEvidence | undefined,
  resultRef: string | null | undefined,
): string[] {
  const urls: string[] = [];
  for (const url of [
    ...(evidence?.prs ?? []),
    ...(parsePrUrl(resultRef) ? [resultRef!.trim()] : []),
  ]) {
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Best effort, never fails the job: with GitHub unreachable the driver's numbers are stored, unverified, with a note.
// `reported` stays what the evidence said.
export async function verifyEvidence(
  env: Env,
  namespace: string,
  evidence: JobEvidence | undefined,
  resultRef?: string | null,
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
    reported: {
      prs: evidence?.prs && evidence.prs.length > 0 ? [...evidence.prs] : null,
      ...reported,
    },
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
  verdict.pr_identity = Object.fromEntries(
    [...read].map(([url, f]) => [url, { node_id: f.node_id, created_at: f.created_at }]),
  );
  github.merged = { ...verdict.pr_states };

  // A partly read list keeps what was read: prs_merged is verified but prs_opened stays unverified, so no reader
  // takes merged for a total (the merge rate reads only rows whose prs_opened is verified).
  if (facts.length !== urls.length) {
    if (facts.length > 0) {
      verdict.prs_merged = facts.filter((f) => f.merged).length;
      verdict.verified.prs_merged = true;
    }
    verdict.notes.push(
      `${facts.length} of ${urls.length} named pull requests could be read. prs_merged counts the ${facts.length} read and is verified; prs_opened, commits and files_changed stay the driver's and unverified, and the run is not judged.`,
    );
    const lastUrl = urls[urls.length - 1];
    const lastRead = read.get(lastUrl);
    if (!lastRead) {
      verdict.notes.push(
        `the last named pull request (${lastUrl}) could not be read, so CI was not looked up`,
      );
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

export function outcomeFrom(
  job: JobRow,
  verdict: EvidenceVerdict,
  now: Date,
  actualModel: string | null = null,
): JobOutcomeRow {
  return {
    job_id: job.id,
    // Copied, not joined, because a release clears claimed_by; "unattributed" only satisfies NOT NULL.
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
    recorded_at: now.toISOString(),
    job_kind: job.kind ?? null,
    model_chosen: job.model_recommended ?? null,
    model_actual: actualModel,
  };
}

// The first record of a job stands; a second terminal transition neither rewrites it nor aborts its batch.
export function outcomeStatement(db: D1Database, row: JobOutcomeRow) {
  return db
    .prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, commits, files_changed,
         tests_added, ci_green, blocked_count, resumed_count, duration_minutes, result_kind, verified,
         recorded_at, job_kind, model_chosen, model_actual)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
       ON CONFLICT(job_id) DO NOTHING`,
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
      row.recorded_at,
      row.job_kind ?? null,
      row.model_chosen ?? null,
      row.model_actual ?? null,
    );
}
