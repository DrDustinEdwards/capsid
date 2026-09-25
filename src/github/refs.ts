import { IMPROVE_BRANCH_PREFIX, isImproveBranch } from "../improve-schema";
import type { AttemptEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  getRefSha,
  ghFetch,
  invalidateRepoReads,
  resolveRepo,
} from "./client";

// The create-a-work-branch step, shared by write_repo_file and delete_repo_file in
// pr mode. create_branch does not use it: as an explicit tool it must fail when the
// branch already exists, and this tolerates that case.
export async function ensureBranch(env: Env, owner: string, repo: string, branch: string, fromSha: string): Promise<void> {
  const created = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  // 422 means the branch already exists, which is fine when a caller passed one.
  if (!created.ok && created.status !== 422) {
    throw new Error(`branch create failed (${created.status}): ${await created.text()}`);
  }
}

export async function createBranch(env: Env, namespace: string, branch: string, from?: string, repoSelector?: string) {
  assertRepoArg("branch", branch);
  if (from) assertRepoArg("from", from);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const base = from || (await getDefaultBranch(env, owner, repo));
  const sha = await getRefSha(env, owner, repo, base);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!resp.ok) throw new Error(`create_branch failed (${resp.status}): ${await resp.text()}`);
  return { repo: `${owner}/${repo}`, branch, from: base, sha };
}

// Branch from an exact commit, which createBranch cannot do; the improve loop
// branches from the commit the lineage picked. ensureBranch tolerates an existing
// branch because an attempt id is unique, so a collision is a retry of that attempt.
export async function createBranchAt(
  env: Env,
  namespace: string,
  branch: string,
  sha: string,
  repoSelector?: string
): Promise<{ repo: string; branch: string; sha: string }> {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  await ensureBranch(env, owner, repo, branch, sha);
  return { repo: full, branch, sha };
}

export async function openPr(
  env: Env,
  namespace: string,
  title: string,
  head: string,
  base?: string,
  body?: string,
  repoSelector?: string
) {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const baseBranch = base || (await getDefaultBranch(env, owner, repo));
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, head, base: baseBranch, body: body ?? "" }),
  });
  if (!resp.ok) throw new Error(`open_pr failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { number: number; html_url: string };
  return { repo: `${owner}/${repo}`, number: data.number, url: data.html_url, head, base: baseBranch };
}

// The head branch is deleted when a PR closes or merges, because write_repo_file's
// PR mode creates a branch per write. Never the default branch, never an improve-loop
// branch (the loop owns those refs), and never a failure of the PR action itself:
// the merge or close already succeeded, so the outcome goes in head_branch_deleted.
async function deleteHeadBranchAfterPr(
  env: Env,
  owner: string,
  repo: string,
  number: number
): Promise<{ head_branch: string | null; head_branch_deleted: boolean; head_branch_note?: string }> {
  try {
    const prResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`);
    if (!prResp.ok) {
      return { head_branch: null, head_branch_deleted: false, head_branch_note: `could not read the PR to find its head branch (${prResp.status})` };
    }
    const pr = (await prResp.json()) as {
      head: { ref: string; repo?: { full_name?: string } | null };
      base: { ref: string };
    };
    const branch = pr.head.ref;

    // A head branch on a FORK is not this App's to delete, and the token could not
    // anyway. Compared by full_name rather than inferred from the ref.
    const headRepo = pr.head.repo?.full_name;
    if (headRepo && headRepo !== `${owner}/${repo}`) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: `head is on ${headRepo}, not this repo, so it was left alone` };
    }
    if (branch === pr.base.ref) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: "head and base are the same branch, so nothing was deleted" };
    }
    const defaultBranch = await getDefaultBranch(env, owner, repo);
    if (branch === defaultBranch) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: "head is the default branch, which is never deleted" };
    }
    if (isImproveBranch(branch)) {
      return {
        head_branch: branch,
        head_branch_deleted: false,
        head_branch_note: `head is under the improve loop's prefix (${IMPROVE_BRANCH_PREFIX}), which owns its own refs, so it was left alone`,
      };
    }
    const del = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs/heads/${encodePath(branch)}`, { method: "DELETE" });
    if (!del.ok) {
      return { head_branch: branch, head_branch_deleted: false, head_branch_note: `delete failed (${del.status}); the PR action itself succeeded` };
    }
    return { head_branch: branch, head_branch_deleted: true };
  } catch (err) {
    return {
      head_branch: null,
      head_branch_deleted: false,
      head_branch_note: `branch cleanup errored: ${err instanceof Error ? err.message : String(err)}; the PR action itself succeeded`,
    };
  }
}

// A merge refused because the PR head is no longer the sha the caller named. GitHub
// answers 409 for that case. Thrown only when an expected sha was passed, so a caller
// that pinned the head can tell this refusal from any other merge failure.
export class HeadMovedError extends Error {
  readonly expectedSha: string;
  constructor(expectedSha: string, detail: string) {
    super(`merge refused: the PR head is no longer ${expectedSha} (409): ${detail}`);
    this.name = "HeadMovedError";
    this.expectedSha = expectedSha;
  }
}

export async function managePr(
  env: Env,
  namespace: string,
  number: number,
  action: "merge" | "close" | "comment",
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
  repoSelector?: string,
  comment?: string,
  // For a merge: the head sha the caller judged. Sent as `sha`, so GitHub merges only
  // that commit and refuses with 409 if the head moved.
  expectedSha?: string
) {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  // A comment leaves the pull request open, so it must never reach the head-branch
  // cleanup below.
  if (action === "comment") {
    if (!comment) throw new Error("comment needs a body; a comment action with nothing to say is a call that did nothing.");
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: comment }),
    });
    if (!resp.ok) throw new Error(`comment failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { id: number; html_url: string };
    return { repo: `${owner}/${repo}`, number, action: "comment", comment_id: data.id, url: data.html_url };
  }
  if (action === "merge") {
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(expectedSha ? { merge_method: mergeMethod, sha: expectedSha } : { merge_method: mergeMethod }),
    });
    if (resp.status === 409 && expectedSha) throw new HeadMovedError(expectedSha, await resp.text());
    if (!resp.ok) throw new Error(`merge failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { sha: string; merged: boolean; message: string };
    // A merge writes every path the PR touched, which are not known here.
    await invalidateRepoReads(env, owner, repo);
    const cleanup = await deleteHeadBranchAfterPr(env, owner, repo, number);
    return {
      repo: `${owner}/${repo}`,
      number,
      action: "merge",
      merged: data.merged,
      sha: data.sha,
      message: data.message,
      ...cleanup,
    };
  }
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  if (!resp.ok) throw new Error(`close failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { number: number; state: string; html_url: string };
  const cleanup = await deleteHeadBranchAfterPr(env, owner, repo, number);
  return { repo: `${owner}/${repo}`, number: data.number, action: "close", state: data.state, url: data.html_url, ...cleanup };
}

// The read tools below expose what the App installation token already reaches. Each
// goes through resolveRepo, ghFetch and cachedGet; nothing opens its own path to
// api.github.com.

/** Branches, tags and open PRs in one call. Ahead/behind is per branch against the
 *  default branch. */
export async function repoRefs(env: Env, namespace: string, repoSelector?: string) {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  const [branchResp, tagResp, prResp] = await Promise.all([
    cachedGet(env, owner, repo, `${base}/branches?per_page=100`),
    cachedGet(env, owner, repo, `${base}/tags?per_page=100`),
    cachedGet(env, owner, repo, `${base}/pulls?state=open&per_page=100`),
  ]);
  if (!branchResp.ok) throw new Error(`repo_refs branches failed (${branchResp.status}): ${(await branchResp.text()).slice(0, 200)}`);
  if (!tagResp.ok) throw new Error(`repo_refs tags failed (${tagResp.status}): ${(await tagResp.text()).slice(0, 200)}`);
  if (!prResp.ok) throw new Error(`repo_refs pulls failed (${prResp.status}): ${(await prResp.text()).slice(0, 200)}`);

  const branchRows = (await branchResp.json()) as Array<{ name: string; commit: { sha: string } }>;
  const tagRows = (await tagResp.json()) as Array<{ name: string; commit: { sha: string } }>;
  const prRows = (await prResp.json()) as Array<{
    number: number;
    title: string;
    head: { ref: string };
    base: { ref: string };
    updated_at: string;
    html_url: string;
  }>;

  const prByHead = new Map(prRows.map((p) => [p.head.ref, p.number]));

  // One compare call per branch, bounded by the 100-branch page above; a repo with
  // more branches reports its first hundred and sets truncated.
  const branches = await Promise.all(
    branchRows.map(async (b) => {
      const row: {
        name: string;
        sha: string;
        committed_date: string | null;
        ahead_by: number | null;
        behind_by: number | null;
        open_pr: number | null;
        is_default: boolean;
      } = {
        name: b.name,
        sha: b.commit.sha,
        committed_date: null,
        ahead_by: null,
        behind_by: null,
        open_pr: prByHead.get(b.name) ?? null,
        is_default: b.name === defaultBranch,
      };
      if (b.name === defaultBranch) {
        row.ahead_by = 0;
        row.behind_by = 0;
        return row;
      }
      const cmp = await cachedGet(
        env,
        owner,
        repo,
        `${base}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`
      );
      if (cmp.ok) {
        const c = (await cmp.json()) as {
          ahead_by: number;
          behind_by: number;
          commits?: Array<{ commit: { committer: { date: string } } }>;
        };
        row.ahead_by = c.ahead_by;
        row.behind_by = c.behind_by;
        const last = c.commits?.[c.commits.length - 1];
        if (last) row.committed_date = last.commit.committer.date;
      }
      return row;
    })
  );

  return {
    repo: full,
    default_branch: defaultBranch,
    truncated: branchRows.length === 100 || tagRows.length === 100 || prRows.length === 100,
    branches,
    tags: tagRows.map((t) => ({ name: t.name, sha: t.commit.sha })),
    pull_requests: prRows.map((p) => ({
      number: p.number,
      title: p.title,
      head: p.head.ref,
      base: p.base.ref,
      updated_at: p.updated_at,
      url: p.html_url,
    })),
  };
}

export const REPO_HISTORY_DEFAULT_LIMIT = 20;
export const REPO_HISTORY_MAX_LIMIT = 100;
export const REPO_PATCH_BUDGET = 200 * 1024;

function summariseCommit(c: { sha: string; commit: { message: string; author: { name: string; date: string } } }) {
  return {
    sha: c.sha,
    date: c.commit.author.date,
    author: c.commit.author.name,
    // First line only; read one commit by sha for the full message.
    subject: c.commit.message.split("\n")[0],
  };
}

// Patch bodies are OFF by default and budgeted when on. The file list is always
// returned: names, status and line counts answer most questions and cost nothing.
function filesWithBudget(
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>,
  wantPatch: boolean
) {
  let spent = 0;
  let truncated = false;
  const out = files.map((f) => {
    const row: { path: string; status: string; additions: number; deletions: number; patch?: string } = {
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

/** Commits, a comparison, or one commit, chosen by which args are present. An
 *  ambiguous combination is refused rather than resolved by precedence. */
export async function repoHistory(
  env: Env,
  namespace: string,
  args: { ref?: string; base?: string; head?: string; sha?: string; limit?: number; patch?: boolean },
  repoSelector?: string
) {
  for (const [kind, value] of [["ref", args.ref], ["base", args.base], ["head", args.head], ["sha", args.sha]] as const) {
    if (value) assertRepoArg(kind, value);
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const apiBase = `/repos/${owner}/${repo}`;

  if (args.base && !args.head) throw new Error("repo_history: base was given without head; a comparison needs both");
  if (args.head && !args.base) throw new Error("repo_history: head was given without base; a comparison needs both");
  const hasCompare = Boolean(args.base && args.head);
  const asked = [args.sha ? "sha" : null, hasCompare ? "base+head" : null, args.ref ? "ref" : null].filter(Boolean);
  if (asked.length > 1) {
    throw new Error(`repo_history: ${asked.join(" and ")} are different questions; pass exactly one of sha, base+head, or ref`);
  }
  if (asked.length === 0) {
    throw new Error("repo_history: pass ref for commits on a ref, base and head to compare, or sha for one commit");
  }

  const limit = Math.min(Math.max(args.limit ?? REPO_HISTORY_DEFAULT_LIMIT, 1), REPO_HISTORY_MAX_LIMIT);

  if (args.sha) {
    const resp = await cachedGet(env, owner, repo, `${apiBase}/commits/${encodeURIComponent(args.sha)}`);
    if (!resp.ok) throw new Error(`repo_history commit failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    const c = (await resp.json()) as {
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      parents: Array<{ sha: string }>;
      files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
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
      `${apiBase}/compare/${encodeURIComponent(args.base as string)}...${encodeURIComponent(args.head as string)}`
    );
    if (!resp.ok) throw new Error(`repo_history compare failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    const c = (await resp.json()) as {
      status: string;
      ahead_by: number;
      behind_by: number;
      total_commits: number;
      commits: Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>;
      files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
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
      commits: c.commits.slice(0, limit).map(summariseCommit),
      files: filesWithBudget(c.files ?? [], args.patch === true),
    };
  }

  const resp = await cachedGet(env, owner, repo, `${apiBase}/commits?sha=${encodeURIComponent(args.ref as string)}&per_page=${limit}`);
  if (!resp.ok) throw new Error(`repo_history commits failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>;
  return { repo: full, mode: "commits" as const, ref: args.ref, limit, commits: rows.map(summariseCommit) };
}

/** Delete a branch. Three refusals; force lifts only two, never the default branch. */
export async function deleteBranch(
  env: Env,
  namespace: string,
  branch: string,
  opts: { force?: boolean } = {},
  repoSelector?: string
) {
  assertRepoArg("branch", branch);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  if (branch === defaultBranch) {
    throw new Error(`delete_branch refuses: ${branch} is the default branch of ${full}. force does not lift this refusal.`);
  }

  if (!opts.force) {
    if (isImproveBranch(branch)) {
      throw new Error(
        `delete_branch refuses: ${branch} is under the improve loop's branch prefix (${IMPROVE_BRANCH_PREFIX}), so it may be an attempt the loop still needs. Pass force: true to delete it anyway.`
      );
    }
    const prResp = await cachedGet(env, owner, repo, `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    // Fail closed: a lookup that errors is not "no open PRs".
    if (!prResp.ok) {
      throw new Error(
        `delete_branch refuses: could not verify open pull requests for ${branch} on ${full} (${prResp.status}), so the open-PR refusal cannot run. Retry, or pass force: true to delete without the check.`
      );
    }
    const prs = (await prResp.json()) as Array<{ number: number; html_url: string }>;
    if (prs.length > 0) {
      throw new Error(
        `delete_branch refuses: ${branch} has open pull request #${prs[0].number} (${prs[0].html_url}). Pass force: true to delete it anyway.`
      );
    }
  }

  const resp = await ghFetch(env, owner, repo, `${base}/git/refs/heads/${encodePath(branch)}`, { method: "DELETE" });
  if (resp.status === 422 || resp.status === 404) {
    throw new Error(`delete_branch failed: ${branch} does not exist on ${full} (${resp.status})`);
  }
  if (!resp.ok) throw new Error(`delete_branch failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  await invalidateRepoReads(env, owner, repo);
  return { repo: full, branch, deleted: true, forced: opts.force === true };
}
