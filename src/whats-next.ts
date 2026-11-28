import type { Env } from "./env";
import { ghFetch, parseReposList } from "./github/client";
import { ciVerdict, readAllPages, readCheckRuns } from "./github/pr-files";
import { readSnapshot } from "./ops-snapshot";
import { externalFence } from "./provenance";
import { board } from "./board";
import type { PortalPr } from "./ops-types/board";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// WHAT NEEDS ME (capsid/research/design-mcp-servers.md, section 3: "the ruling's 'what needs me'":
// all open PRs across repos with CI and conflicts).

const PRS_PER_REPO = 30;
const PRS_TOTAL = 120;
const REPOS_MAX = 60;
const LIST_MAX_PAGES = 1;
const CHECKS_MAX_PAGES = 5;

interface RawPr {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  created_at: string;
  user?: { login?: string } | null;
  head: { sha: string; ref: string };
}


/** The repos each registered namespace maps, deduplicated across namespaces. */
export async function mappedRepos(
  db: D1Database,
  notChecked?: string[],
): Promise<Array<{ namespace: string; repo: string }>> {
  const { results } = await db
    .prepare("SELECT namespace, repos FROM namespaces ORDER BY namespace")
    .all<{ namespace: string; repos: string }>();
  const seen = new Set<string>();
  const out: Array<{ namespace: string; repo: string }> = [];
  for (const row of results ?? []) {
    const parsed = parseReposList(row.repos);
    if ("error" in parsed) {
      notChecked?.push(
        `${row.namespace}'s repo mapping does not parse, so its pull requests were not read: ${parsed.error}`,
      );
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

async function openPrs(
  env: Env,
  namespace: string,
  full: string,
  notChecked: string[],
): Promise<PortalPr[]> {
  const [owner, repo] = full.split("/");
  const listed = await readAllPages<RawPr>(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/pulls?state=open&per_page=${PRS_PER_REPO}`,
    (page) => page as RawPr[],
    LIST_MAX_PAGES,
  );
  if (listed.problem) notChecked.push(`${full} open pull requests: ${listed.problem}`);
  const out: PortalPr[] = [];
  for (const pr of listed.items.slice(0, PRS_PER_REPO)) {
    const checks = await readCheckRuns(env, owner, repo, pr.head.sha, CHECKS_MAX_PAGES);
    const verdict = checks.problem
      ? { conclusion: null, note: `check runs not read: ${checks.problem}` }
      : ciVerdict(checks.items);
    // The list does not carry mergeability; one read of the pull request does. GitHub
    // computes it lazily, so a null mergeable is "not known yet", never "no conflict".
    let conflict: boolean | null = null;
    const one = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}`);
    if (one.ok) {
      const detail = (await one.json()) as { mergeable?: boolean | null; mergeable_state?: string };
      conflict =
        detail.mergeable_state === "dirty" ? true : detail.mergeable === true ? false : null;
    } else {
      await one.body?.cancel();
      notChecked.push(`${full}#${pr.number} mergeability: ${one.status}`);
    }
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
      ci: verdict.conclusion,
      ci_note: verdict.note,
      conflict,
    });
  }
  return out;
}

/** Every open pull request in every mapped repo, read in turn (slow: one GitHub read per PR and more). */
export async function readOpenPrs(
  env: Env,
  notChecked: string[],
): Promise<{ prs: PortalPr[]; repos_read: number }> {
  const prs: PortalPr[] = [];
  let repos: Array<{ namespace: string; repo: string }> = [];
  try {
    repos = await mappedRepos(env.DB, notChecked);
  } catch (err) {
    notChecked.push(`the namespace mapping: ${errorMessage(err)}`);
  }
  if (repos.length > REPOS_MAX)
    notChecked.push(`${repos.length - REPOS_MAX} mapped repos were not read`);
  for (const { namespace, repo } of repos.slice(0, REPOS_MAX)) {
    if (prs.length >= PRS_TOTAL) {
      notChecked.push(
        `stopped at ${PRS_TOTAL} open pull requests; ${repo} and later repos were not read`,
      );
      break;
    }
    try {
      prs.push(...(await openPrs(env, namespace, repo, notChecked)));
    } catch (err) {
      notChecked.push(`${repo}: ${errorMessage(err)}`);
    }
  }
  return { prs, repos_read: Math.min(repos.length, REPOS_MAX) };
}

export async function whatsNext(env: Env, now: Date = new Date()) {
  const notChecked: string[] = [];
  const { prs, repos_read } = await readOpenPrs(env, notChecked);

  let checks: Array<{ id: string; state: string; findings: string[] }> = [];
  let passAt: string | null = null;
  try {
    const snapshot = await readSnapshot(env);
    passAt = snapshot?.pass_at ?? null;
    checks = (snapshot?.checks ?? []).filter((c) => c.state !== "clear");
    if (!snapshot) notChecked.push("the watcher has written no pass yet");
  } catch (err) {
    notChecked.push(`the watcher's last pass: ${errorMessage(err)}`);
  }

  const coordinator = await board(env, prs, notChecked);

  return {
    as_of: now.toISOString(),
    ...coordinator,
    pull_requests: {
      red: prs.filter((p) => p.ci === "failure"),
      conflicts: prs.filter((p) => p.conflict === true),
      all: prs,
      repos_read,
    },
    checks: { pass_at: passAt, failing: checks },
    not_checked: notChecked,
  };
}
