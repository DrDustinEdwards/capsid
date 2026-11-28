import { readAllPages } from "@dustinedwards/site-runtime/github";
import type { RepoEnv as Env } from "../env";
import { encodePath, getDefaultBranch, ghFetch, invalidateRepoReads, resolveRepo } from "./client";

// Reads are live, not cached: a stale list is how a branch with new work gets deleted. A branch is
// pruned only when its latest pull request merged and its tip is the merged commit; anything
// uncertain is kept.

const PAGE_SIZE = 100;
const PAGE_CAP = 10;
// Capped so one call's subrequests stay bounded; the seat repeats until none remain.
const DELETE_CAP = 40;
const KEPT_LISTED = 200;
const NEVER_PRUNED = new Set(["screenshots", "results", "gh-pages"]);
const NEVER_PRUNED_PREFIXES = ["release/"];

interface BranchRow {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

interface PullRow {
  number: number;
  state: string;
  merged_at: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  body?: string | null;
}

export interface PruneKept {
  branch: string;
  reason: string;
}

export interface PruneCandidate {
  branch: string;
  sha: string;
  pr: number | null;
}

// Screenshot branches (shots/... or ...-shots) are kept while an open pull request's description
// names them.
const SHOTS_BRANCH = /^shots\/|-shots$/;

function shotsInUse(
  branch: { name: string; sha: string },
  open: ReadonlyArray<{ number: number; body?: string | null }>,
): number | null {
  if (!SHOTS_BRANCH.test(branch.name)) return null;
  const used = open.find(
    (pr) => (pr.body ?? "").includes(branch.name) || (pr.body ?? "").includes(branch.sha),
  );
  return used ? used.number : null;
}

// orphan: no open pull request and nothing merged, so the daily pass may delete it once it is old.
// afterMerge: the merged pull request whose head the branch has moved past; never deleted.
type PruneVerdict =
  | { prune: true; pr: number }
  | { prune: false; reason: string; orphan: boolean; afterMerge?: number };

export function pruneVerdict(
  branch: { name: string; sha: string; protected: boolean },
  defaultBranch: string,
  latest: { number: number; state: string; merged: boolean; headSha: string } | undefined,
  listsComplete: boolean,
): PruneVerdict {
  if (branch.name === defaultBranch)
    return { prune: false, reason: "default branch", orphan: false };
  if (branch.protected) return { prune: false, reason: "protected branch", orphan: false };
  if (
    NEVER_PRUNED.has(branch.name) ||
    NEVER_PRUNED_PREFIXES.some((p) => branch.name.startsWith(p))
  ) {
    return {
      prune: false,
      reason: "kept by name (release, screenshots, results, gh-pages)",
      orphan: false,
    };
  }
  if (!latest) {
    return {
      prune: false,
      reason: listsComplete
        ? "no pull request"
        : "no pull request found in the part of the list that was read",
      orphan: true,
    };
  }
  if (latest.state === "open")
    return { prune: false, reason: `open pull request #${latest.number}`, orphan: false };
  if (!latest.merged)
    return {
      prune: false,
      reason: `pull request #${latest.number} was closed without merging`,
      orphan: true,
    };
  if (latest.headSha !== branch.sha)
    return {
      prune: false,
      reason: `commits after pull request #${latest.number} merged`,
      orphan: false,
      afterMerge: latest.number,
    };
  // A list not read whole may hide a newer open pull request on the same head, so a
  // delete waits until it can be read whole.
  if (!listsComplete)
    return {
      prune: false,
      reason: `pull request #${latest.number} merged, but the pull request list was not read whole`,
      orphan: false,
    };
  return { prune: true, pr: latest.number };
}

async function paged<T>(
  env: Env,
  owner: string,
  repo: string,
  path: string,
): Promise<{ rows: T[]; complete: boolean }> {
  const { items, problem, truncated } = await readAllPages<T>(
    (p) => ghFetch(env, owner, repo, p),
    path,
    {
      maxPages: PAGE_CAP,
      perPage: PAGE_SIZE,
    },
  );
  if (problem && !truncated)
    throw new Error(`delete_branch merged: reading ${path} failed (${problem})`);
  return { rows: items, complete: problem === null };
}

export interface PrunePlan {
  owner: string;
  name: string;
  repo: string;
  defaultBranch: string;
  branchesRead: number;
  listsComplete: boolean;
  openComplete: boolean;
  prune: PruneCandidate[];
  kept: PruneKeptRow[];
}

interface PruneKeptRow extends PruneKept {
  sha: string;
  orphan: boolean;
  afterMerge?: number;
}

export async function readPrunePlan(
  env: Env,
  namespace: string,
  keep: string[] = [],
  repoSelector?: string,
): Promise<PrunePlan> {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  const branches = await paged<BranchRow>(env, owner, repo, `${base}/branches`);
  const open = await paged<PullRow>(env, owner, repo, `${base}/pulls?state=open`);
  const closed = await paged<PullRow>(
    env,
    owner,
    repo,
    `${base}/pulls?state=closed&sort=updated&direction=desc`,
  );
  const listsComplete = branches.complete && open.complete && closed.complete;

  // The newest pull request per head branch, from this repo only: a fork's pull request can
  // carry a head branch of the same name.
  const latest = new Map<
    string,
    { number: number; state: string; merged: boolean; headSha: string }
  >();
  for (const pr of [...open.rows, ...closed.rows]) {
    if (pr.head.repo?.full_name?.toLowerCase() !== full.toLowerCase()) continue;
    const seen = latest.get(pr.head.ref);
    if (!seen || pr.number > seen.number) {
      latest.set(pr.head.ref, {
        number: pr.number,
        state: pr.state,
        merged: pr.merged_at !== null,
        headSha: pr.head.sha,
      });
    }
  }

  const prune: PruneCandidate[] = [];
  const kept: PruneKeptRow[] = [];
  const keepNames = new Set(keep);
  for (const b of branches.rows) {
    if (keepNames.has(b.name)) {
      kept.push({
        branch: b.name,
        reason: "kept by request (keep)",
        sha: b.commit.sha,
        orphan: false,
      });
      continue;
    }
    const verdict = pruneVerdict(
      { name: b.name, sha: b.commit.sha, protected: b.protected === true },
      defaultBranch,
      latest.get(b.name),
      listsComplete,
    );
    const shotsFor =
      !verdict.prune && verdict.orphan
        ? shotsInUse({ name: b.name, sha: b.commit.sha }, open.rows)
        : null;
    if (shotsFor !== null) {
      kept.push({
        branch: b.name,
        reason: `screenshots for open pull request #${shotsFor}`,
        sha: b.commit.sha,
        orphan: false,
      });
      continue;
    }
    if (verdict.prune) prune.push({ branch: b.name, sha: b.commit.sha, pr: verdict.pr });
    else
      kept.push({
        branch: b.name,
        reason: verdict.reason,
        sha: b.commit.sha,
        orphan: verdict.orphan,
        ...(verdict.afterMerge ? { afterMerge: verdict.afterMerge } : {}),
      });
  }
  return {
    owner,
    name: repo,
    repo: full,
    defaultBranch,
    branchesRead: branches.rows.length,
    listsComplete,
    openComplete: open.complete,
    prune,
    kept,
  };
}

// Each tip is re-read and a moved branch skipped; `record` runs before each delete, and a throw
// stops the rest.
export async function deletePruneCandidates(
  env: Env,
  plan: PrunePlan,
  cap: number,
  record?: (c: PruneCandidate) => Promise<void>,
) {
  const { owner, name: repo } = plan;
  const base = `/repos/${owner}/${repo}`;
  const deleted: PruneCandidate[] = [];
  const skipped: PruneKept[] = [];
  const batch = plan.prune.slice(0, cap);
  for (const c of batch) {
    let tip: string | undefined;
    try {
      const ref = await ghFetch(env, owner, repo, `${base}/git/ref/heads/${encodePath(c.branch)}`);
      if (ref.ok) tip = ((await ref.json()) as { object?: { sha?: string } }).object?.sha;
    } catch {
      tip = undefined;
    }
    if (tip === undefined) {
      skipped.push({
        branch: c.branch,
        reason: "could not re-read the branch tip, so it was not deleted",
      });
      continue;
    }
    if (tip !== c.sha) {
      skipped.push({
        branch: c.branch,
        reason: "the branch moved since the preview, so it was not deleted",
      });
      continue;
    }
    await record?.(c);
    const resp = await ghFetch(env, owner, repo, `${base}/git/refs/heads/${encodePath(c.branch)}`, {
      method: "DELETE",
    });
    if (resp.ok) deleted.push(c);
    else if (resp.status === 404 || resp.status === 422)
      skipped.push({ branch: c.branch, reason: `already gone (${resp.status})` });
    else skipped.push({ branch: c.branch, reason: `GitHub refused the delete (${resp.status})` });
  }
  if (batch.length > 0) await invalidateRepoReads(env, owner, repo);
  return { deleted, skipped, remaining: plan.prune.length - batch.length };
}

export async function pruneMergedBranches(
  env: Env,
  namespace: string,
  opts: { confirm?: boolean; keep?: string[] } = {},
  repoSelector?: string,
) {
  const plan = await readPrunePlan(env, namespace, opts.keep, repoSelector);
  const kept = plan.kept.map(({ branch, reason }) => ({ branch, reason }));
  const result = {
    repo: plan.repo,
    mode: opts.confirm ? ("delete" as const) : ("preview" as const),
    branches_read: plan.branchesRead,
    lists_complete: plan.listsComplete,
    would_prune: plan.prune.length,
    kept_count: kept.length,
    kept: kept.slice(0, KEPT_LISTED),
    kept_truncated: kept.length > KEPT_LISTED,
    prune: plan.prune,
    deleted: [] as string[],
    skipped: [] as PruneKept[],
    remaining: 0,
  };
  if (!opts.confirm) return result;

  const done = await deletePruneCandidates(env, plan, DELETE_CAP);
  result.deleted = done.deleted.map((c) => c.branch);
  result.skipped = done.skipped;
  result.remaining = done.remaining;
  return result;
}
