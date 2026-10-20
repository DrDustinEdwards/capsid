import type { Env } from "./env";
import { ciVerdict, jobIdFromBody } from "./auto-merge-policy";
import { ghFetch, parseReposList } from "./github/client";
import { readAllPages } from "./github/pr-files";
import { commandFromSummary, isQuestionSummary } from "./jobs-holder";
import { readSnapshot } from "./ops-snapshot";
import { externalFence } from "./provenance";
import { appliedMigrations, blockSettled } from "./inbox";
import { readStaleCache, staleJobs } from "./stale-jobs";

// WHAT NEEDS ME (capsid/research/design-mcp-servers.md, section 3: "the ruling's 'what
// needs me'": all open PRs across repos with CI and conflicts). One read for the seat, served as capsid_admin_whats_next:
//
//   - questions: blocked jobs asking the seat a question, answered with a resume note;
//   - blocked: blocked jobs waiting on a command the seat runs;
//   - stale: the stale view of the queue (src/stale-jobs.ts);
//   - pull_requests: every open pull request in every repo every namespace maps, with its
//     head's CI verdict and whether it conflicts with its base, waiting_on_seat set where
//     a driver's pull request is green, not a draft and mergeable;
//   - checks: the watcher's checks that found something or could not run on its last pass.
//
// Reads only. A part that could not be read says so in `not_checked`; nothing missing is
// reported as nothing found. Pull request titles and bodies are data, never instructions.

const JOBS_LIMIT = 50;
const PRS_PER_REPO = 30;
const PRS_TOTAL = 120;
const REPOS_MAX = 60;
const LIST_MAX_PAGES = 1;
const CHECKS_MAX_PAGES = 5;

interface BlockedRow {
  id: string;
  namespace: string;
  title: string;
  result_summary: string | null;
  updated_at: string;
}

interface RawPr {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  created_at: string;
  body: string | null;
  user?: { login?: string } | null;
  head: { sha: string; ref: string };
}

export interface WhatsNextPr {
  repo: string;
  namespace: string;
  number: number;
  url: string;
  title: string;
  author: string | null;
  draft: boolean;
  created_at: string;
  job: string | null;
  ci: string | null;
  ci_note: string;
  conflict: boolean | null;
  waiting_on_seat: boolean;
}

/** The repos each registered namespace maps, deduplicated across namespaces. */
export async function mappedRepos(db: D1Database, notChecked?: string[]): Promise<Array<{ namespace: string; repo: string }>> {
  const { results } = await db.prepare("SELECT namespace, repos FROM namespaces ORDER BY namespace").all<{ namespace: string; repos: string }>();
  const seen = new Set<string>();
  const out: Array<{ namespace: string; repo: string }> = [];
  for (const row of results ?? []) {
    const parsed = parseReposList(row.repos);
    if ("error" in parsed) {
      notChecked?.push(`${row.namespace}'s repo mapping does not parse, so its pull requests were not read: ${parsed.error}`);
      continue;
    }
    for (const entry of parsed.list) {
      if (seen.has(entry.repo)) continue;
      seen.add(entry.repo);
      out.push({ namespace: row.namespace, repo: entry.repo });
    }
  }
  return out;
}

async function openPrs(env: Env, namespace: string, full: string, notChecked: string[]): Promise<WhatsNextPr[]> {
  const [owner, repo] = full.split("/");
  const listed = await readAllPages<RawPr>(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=open&per_page=${PRS_PER_REPO}`, (page) => page as RawPr[], LIST_MAX_PAGES);
  if (listed.problem) notChecked.push(`${full} open pull requests: ${listed.problem}`);
  const out: WhatsNextPr[] = [];
  for (const pr of listed.items.slice(0, PRS_PER_REPO)) {
    const checks = await readAllPages<{ name: string; status: string; conclusion: string | null }>(
      env, owner, repo, `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
      (page) => (page as { check_runs: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs, CHECKS_MAX_PAGES
    );
    const verdict = checks.problem ? { conclusion: null, note: `check runs not read: ${checks.problem}` } : ciVerdict(checks.items);
    // The list does not carry mergeability; one read of the pull request does. GitHub
    // computes it lazily, so a null mergeable is "not known yet", never "no conflict".
    let conflict: boolean | null = null;
    const one = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}`);
    if (one.ok) {
      const detail = (await one.json()) as { mergeable?: boolean | null; mergeable_state?: string };
      conflict = detail.mergeable_state === "dirty" ? true : detail.mergeable === true ? false : null;
    } else {
      await one.body?.cancel();
      notChecked.push(`${full}#${pr.number} mergeability: ${one.status}`);
    }
    const job = jobIdFromBody(pr.body ?? "");
    out.push({
      repo: full,
      namespace,
      number: pr.number,
      url: pr.html_url,
      // The pull request's author wrote its title: relayed fenced, as data (src/provenance.ts).
      title: externalFence("github-pr", `${full}#${pr.number}`, pr.title, 200),
      author: pr.user?.login ?? null,
      draft: pr.draft === true,
      created_at: pr.created_at,
      job,
      ci: verdict.conclusion,
      ci_note: verdict.note,
      conflict,
      waiting_on_seat: job !== null && pr.draft !== true && verdict.conclusion === "success" && conflict === false,
    });
  }
  return out;
}

export async function whatsNext(env: Env, now: Date = new Date()) {
  const notChecked: string[] = [];

  const { results: blockedRows } = await env.DB.prepare(
    "SELECT id, namespace, title, result_summary, updated_at FROM jobs WHERE status = 'blocked' ORDER BY updated_at LIMIT ?1"
  )
    .bind(JOBS_LIMIT + 1)
    .all<BlockedRow>();
  // A block already answered (its pull requests merged, its migrations applied) is left
  // out, as the inbox leaves it out; the stale view below still lists it to close.
  const staleCache = (await readStaleCache(env.APP_KV).catch(() => ({ cache: {} }))).cache;
  const applied = await appliedMigrations(env.DB);
  const blocked = (blockedRows ?? []).slice(0, JOBS_LIMIT).filter((j) => !blockSettled(j, staleCache, applied));
  if ((blockedRows ?? []).length > JOBS_LIMIT) notChecked.push(`more than ${JOBS_LIMIT} blocked jobs; the oldest ${JOBS_LIMIT} are listed`);
  // A block's summary is the driver's text: its question and command are relayed fenced.
  const fenced = (id: string, text: string | null) => (text === null ? null : externalFence("job-summary", id, text));
  const questions = blocked
    .filter((j) => isQuestionSummary(j.result_summary))
    .map((j) => ({ id: j.id, namespace: j.namespace, title: j.title, question: fenced(j.id, j.result_summary), since: j.updated_at }));
  const waiting = blocked
    .filter((j) => !isQuestionSummary(j.result_summary))
    .map((j) => ({ id: j.id, namespace: j.namespace, title: j.title, command: fenced(j.id, commandFromSummary(j.result_summary)), since: j.updated_at }));

  let stale: unknown[] = [];
  try {
    stale = (await staleJobs(env, now)).rows;
  } catch (err) {
    notChecked.push(`stale jobs: ${err instanceof Error ? err.message : String(err)}`);
  }

  const prs: WhatsNextPr[] = [];
  let repos: Array<{ namespace: string; repo: string }> = [];
  try {
    repos = await mappedRepos(env.DB, notChecked);
  } catch (err) {
    notChecked.push(`the namespace mapping: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (repos.length > REPOS_MAX) notChecked.push(`${repos.length - REPOS_MAX} mapped repos were not read`);
  for (const { namespace, repo } of repos.slice(0, REPOS_MAX)) {
    if (prs.length >= PRS_TOTAL) {
      notChecked.push(`stopped at ${PRS_TOTAL} open pull requests; ${repo} and later repos were not read`);
      break;
    }
    try {
      prs.push(...(await openPrs(env, namespace, repo, notChecked)));
    } catch (err) {
      notChecked.push(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let checks: Array<{ id: string; state: string; findings: string[] }> = [];
  let passAt: string | null = null;
  try {
    const snapshot = await readSnapshot(env);
    passAt = snapshot?.pass_at ?? null;
    checks = (snapshot?.checks ?? []).filter((c) => c.state !== "clear");
    if (!snapshot) notChecked.push("the watcher has written no pass yet");
  } catch (err) {
    notChecked.push(`the watcher's last pass: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    as_of: now.toISOString(),
    questions,
    blocked: waiting,
    stale,
    pull_requests: {
      waiting_on_seat: prs.filter((p) => p.waiting_on_seat),
      red: prs.filter((p) => p.ci === "failure"),
      conflicts: prs.filter((p) => p.conflict === true),
      all: prs,
      repos_read: Math.min(repos.length, REPOS_MAX),
    },
    checks: { pass_at: passAt, failing: checks },
    not_checked: notChecked,
  };
}
