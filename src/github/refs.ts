import type { RepoEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  ghFetch,
  invalidateRepoReads,
  resolveRepo,
} from "./client";

import { errorMessage } from "@dustinedwards/site-runtime/log";

// After a merge the head branch is deleted only while its tip is the commit that merged, so work
// pushed during the merge survives; the tip goes into the result and so into the audit row. The
// default branch and a fork's branch are never deleted, and a failed delete never fails the merge.
async function deleteMergedHead(
  env: Env,
  owner: string,
  repo: string,
  number: number,
): Promise<{
  head_branch: string | null;
  head_branch_sha?: string;
  head_branch_deleted: boolean;
  head_branch_note?: string;
}> {
  const kept = (head_branch: string | null, head_branch_note: string) => ({
    head_branch,
    head_branch_deleted: false,
    head_branch_note,
  });
  try {
    const prResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}`);
    if (!prResp.ok)
      return kept(null, `could not read the PR to find its head branch (${prResp.status})`);
    const pr = (await prResp.json()) as {
      head: { ref: string; sha?: string; repo?: { full_name?: string } | null };
      base: { ref: string };
    };
    const branch = pr.head.ref;
    const headRepo = pr.head.repo?.full_name;
    if (headRepo && headRepo !== `${owner}/${repo}`)
      return kept(branch, `head is on ${headRepo}, not this repo, so it was left alone`);
    if (branch === pr.base.ref)
      return kept(branch, "head and base are the same branch, so nothing was deleted");
    if (branch === (await getDefaultBranch(env, owner, repo)))
      return kept(branch, "head is the default branch, which is never deleted");
    const ref = `/repos/${owner}/${repo}/git/ref/heads/${encodePath(branch)}`;
    const tipResp = await ghFetch(env, owner, repo, ref);
    const tip = tipResp.ok
      ? ((await tipResp.json()) as { object?: { sha?: string } }).object?.sha
      : undefined;
    if (!tip || tip !== pr.head.sha)
      return kept(
        branch,
        tip
          ? `the branch has commits after the merged head ${pr.head.sha}, so it was kept`
          : `could not read the branch tip (${tipResp.status}), so it was kept`,
      );
    const del = await ghFetch(
      env,
      owner,
      repo,
      `/repos/${owner}/${repo}/git/refs/heads/${encodePath(branch)}`,
      { method: "DELETE" },
    );
    if (!del.ok) return kept(branch, `delete failed (${del.status}); the merge itself succeeded`);
    return { head_branch: branch, head_branch_sha: tip, head_branch_deleted: true };
  } catch (err) {
    return kept(null, `branch cleanup errored: ${errorMessage(err)}; the merge itself succeeded`);
  }
}

// GitHub answers 409 when the head is no longer the sha the caller named; thrown only when a sha
// was passed.
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
  action: "merge" | "close",
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
  repoSelector?: string,
  expectedSha?: string,
) {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  if (action === "merge") {
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        expectedSha
          ? { merge_method: mergeMethod, sha: expectedSha }
          : { merge_method: mergeMethod },
      ),
    });
    if (resp.status === 409 && expectedSha)
      throw new HeadMovedError(expectedSha, await resp.text());
    if (!resp.ok) throw new Error(`merge failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { sha: string; merged: boolean; message: string };
    // A merge writes every path the PR touched, so the whole repo's reads go.
    await invalidateRepoReads(env, owner, repo);
    const cleanup = await deleteMergedHead(env, owner, repo, number);
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
  return {
    repo: `${owner}/${repo}`,
    number: data.number,
    action: "close",
    state: data.state,
    url: data.html_url,
  };
}

export async function repoRefs(env: Env, namespace: string, repoSelector?: string) {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  const [branchResp, tagResp, prResp] = await Promise.all([
    cachedGet(env, owner, repo, `${base}/branches?per_page=100`),
    cachedGet(env, owner, repo, `${base}/tags?per_page=100`),
    cachedGet(env, owner, repo, `${base}/pulls?state=open&per_page=100`),
  ]);
  if (!branchResp.ok)
    throw new Error(
      `repo_refs branches failed (${branchResp.status}): ${(await branchResp.text()).slice(0, 200)}`,
    );
  if (!tagResp.ok)
    throw new Error(
      `repo_refs tags failed (${tagResp.status}): ${(await tagResp.text()).slice(0, 200)}`,
    );
  if (!prResp.ok)
    throw new Error(
      `repo_refs pulls failed (${prResp.status}): ${(await prResp.text()).slice(0, 200)}`,
    );

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

  // Compare endpoint, one call per branch; the default branch is skipped and the fan-out is bounded
  // by the 100-branch page.
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
        `${base}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`,
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
    }),
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

export async function deleteBranch(
  env: Env,
  namespace: string,
  branch: string,
  opts: { force?: boolean } = {},
  repoSelector?: string,
) {
  assertRepoArg("branch", branch);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  // Not liftable by force: a flag that could delete a repo's default branch
  // eventually will, so this is checked before force is read.
  if (branch === defaultBranch) {
    throw new Error(
      `delete_branch refuses: ${branch} is the default branch of ${full}. force does not lift this refusal.`,
    );
  }

  if (!opts.force) {
    // Live, not cachedGet: a PR opened in the last minute must still stop the delete
    // (prune.ts reads live for the same reason).
    const prResp = await ghFetch(
      env,
      owner,
      repo,
      `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    // Fail closed: a lookup that errors is not "no open PRs". Skipping the refusal on
    // a 5xx would delete the branches this check protects whenever GitHub is flaky.
    if (!prResp.ok) {
      throw new Error(
        `delete_branch refuses: could not verify open pull requests for ${branch} on ${full} (${prResp.status}), so the open-PR refusal cannot run. Retry, or pass force: true to delete without the check.`,
      );
    }
    const prs = (await prResp.json()) as Array<{ number: number; html_url: string }>;
    if (prs.length > 0) {
      throw new Error(
        `delete_branch refuses: ${branch} has open pull request #${prs[0].number} (${prs[0].html_url}). Pass force: true to delete it anyway.`,
      );
    }
  }

  const resp = await ghFetch(env, owner, repo, `${base}/git/refs/heads/${encodePath(branch)}`, {
    method: "DELETE",
  });
  if (resp.status === 422 || resp.status === 404) {
    throw new Error(`delete_branch failed: ${branch} does not exist on ${full} (${resp.status})`);
  }
  if (!resp.ok)
    throw new Error(`delete_branch failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  await invalidateRepoReads(env, owner, repo);
  return { repo: full, branch, deleted: true, forced: opts.force === true };
}

// Merge settings, the default branch's rules, the rulesets and private vulnerability reporting,
// all readable with the App's Metadata permission. Fields GitHub shows only to an admin come back
// null rather than guessed.
export async function repoSettings(env: Env, namespace: string, repoSelector?: string) {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const json = async (path: string) => {
    const resp = await cachedGet(env, owner, repo, `${base}${path}`);
    if (!resp.ok)
      throw new Error(
        `repo_settings ${path || "/"} failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`,
      );
    return resp.json() as Promise<Record<string, unknown>>;
  };
  const info = await json("");
  const branch = info.default_branch as string;
  const [rules, rulesets, pvr] = await Promise.all([
    json(`/rules/branches/${encodeURIComponent(branch)}`) as Promise<unknown>,
    json("/rulesets?per_page=100") as Promise<unknown>,
    json("/private-vulnerability-reporting"),
  ]);
  const pick = (k: string) => info[k] ?? null;
  return {
    repo: full,
    default_branch: branch,
    visibility: pick("visibility"),
    archived: pick("archived"),
    allow_auto_merge: pick("allow_auto_merge"),
    allow_squash_merge: pick("allow_squash_merge"),
    allow_merge_commit: pick("allow_merge_commit"),
    allow_rebase_merge: pick("allow_rebase_merge"),
    delete_branch_on_merge: pick("delete_branch_on_merge"),
    security_and_analysis: pick("security_and_analysis"),
    private_vulnerability_reporting: pvr.enabled ?? null,
    branch_rules: (rules as Array<{ type: string; ruleset_id?: number; parameters?: unknown }>).map(
      ({ type, ruleset_id, parameters }) => ({ type, ruleset_id, parameters }),
    ),
    rulesets: (rulesets as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      name: r.name,
      target: r.target,
      enforcement: r.enforcement,
    })),
  };
}
