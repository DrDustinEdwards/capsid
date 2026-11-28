import type { RepoEnv as Env } from "../env";
import { assertRepoArg, cachedGet, resolveRepo } from "./client";

export const REPO_HISTORY_DEFAULT_LIMIT = 20;
export const REPO_HISTORY_MAX_LIMIT = 100;
export const REPO_PATCH_BUDGET = 200 * 1024;

function summarizeCommit(c: {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
}) {
  return {
    sha: c.sha,
    date: c.commit.author.date,
    author: c.commit.author.name,
    // First line only: commit bodies bury the shape of the history.
    subject: c.commit.message.split("\n")[0],
  };
}

function filesWithBudget(
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>,
  wantPatch: boolean,
) {
  let spent = 0;
  let truncated = false;
  const out = files.map((f) => {
    const row: {
      path: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    } = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    };
    if (wantPatch && f.patch) {
      if (spent + f.patch.length <= REPO_PATCH_BUDGET) {
        row.patch = f.patch;
        spent += f.patch.length;
      } else {
        truncated = true;
      }
    }
    return row;
  });
  return { count: out.length, patch_truncated: truncated, patch_bytes: spent, entries: out };
}

/** An ambiguous combination is refused, not resolved by precedence. */
export async function repoHistory(
  env: Env,
  namespace: string,
  args: {
    ref?: string;
    base?: string;
    head?: string;
    sha?: string;
    limit?: number;
    patch?: boolean;
  },
  repoSelector?: string,
) {
  for (const [kind, value] of [
    ["ref", args.ref],
    ["base", args.base],
    ["head", args.head],
    ["sha", args.sha],
  ] as const) {
    if (value) assertRepoArg(kind, value);
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const apiBase = `/repos/${owner}/${repo}`;

  if (args.base && !args.head)
    throw new Error("repo_history: base was given without head; a comparison needs both");
  if (args.head && !args.base)
    throw new Error("repo_history: head was given without base; a comparison needs both");
  const hasCompare = Boolean(args.base && args.head);
  const asked = [
    args.sha ? "sha" : null,
    hasCompare ? "base+head" : null,
    args.ref ? "ref" : null,
  ].filter(Boolean);
  if (asked.length > 1) {
    throw new Error(
      `repo_history: ${asked.join(" and ")} are different questions; pass exactly one of sha, base+head, or ref`,
    );
  }
  if (asked.length === 0) {
    throw new Error(
      "repo_history: pass ref for commits on a ref, base and head to compare, or sha for one commit",
    );
  }

  const limit = Math.min(
    Math.max(args.limit ?? REPO_HISTORY_DEFAULT_LIMIT, 1),
    REPO_HISTORY_MAX_LIMIT,
  );

  if (args.sha) {
    const resp = await cachedGet(
      env,
      owner,
      repo,
      `${apiBase}/commits/${encodeURIComponent(args.sha)}`,
    );
    if (!resp.ok)
      throw new Error(
        `repo_history commit failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`,
      );
    const c = (await resp.json()) as {
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      parents: Array<{ sha: string }>;
      files?: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>;
    };
    return {
      repo: full,
      mode: "commit" as const,
      commit: {
        sha: c.sha,
        date: c.commit.author.date,
        author: c.commit.author.name,
        message: c.commit.message,
        parents: c.parents.map((p) => p.sha),
      },
      files: filesWithBudget(c.files ?? [], args.patch === true),
    };
  }

  if (hasCompare) {
    const resp = await cachedGet(
      env,
      owner,
      repo,
      `${apiBase}/compare/${encodeURIComponent(args.base as string)}...${encodeURIComponent(args.head as string)}`,
    );
    if (!resp.ok)
      throw new Error(
        `repo_history compare failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`,
      );
    const c = (await resp.json()) as {
      status: string;
      ahead_by: number;
      behind_by: number;
      total_commits: number;
      commits: Array<{
        sha: string;
        commit: { message: string; author: { name: string; date: string } };
      }>;
      files?: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>;
    };
    return {
      repo: full,
      mode: "compare" as const,
      base: args.base,
      head: args.head,
      status: c.status,
      ahead_by: c.ahead_by,
      behind_by: c.behind_by,
      total_commits: c.total_commits,
      // GitHub lists the range oldest first; the newest are kept.
      commits: c.commits.slice(-limit).map(summarizeCommit),
      files: filesWithBudget(c.files ?? [], args.patch === true),
    };
  }

  const resp = await cachedGet(
    env,
    owner,
    repo,
    `${apiBase}/commits?sha=${encodeURIComponent(args.ref as string)}&per_page=${limit}`,
  );
  if (!resp.ok)
    throw new Error(
      `repo_history commits failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`,
    );
  const rows = (await resp.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
  }>;
  return {
    repo: full,
    mode: "commits" as const,
    ref: args.ref,
    limit,
    commits: rows.map(summarizeCommit),
  };
}
