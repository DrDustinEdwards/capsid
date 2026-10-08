import { isImproveBranch } from "../improve-schema";
import type { AttemptEnv as Env } from "../env";
import { encodePath, getDefaultBranch, ghFetch, invalidateRepoReads, resolveRepo } from "./client";

// PRUNE MERGED BRANCHES (job_8779278b8e91, Dustin 2026-10-07). delete_branch with merged:true
// finds the branches whose work has landed and, only with confirm:true, deletes them. A branch
// is pruned only when its LATEST pull request in this repo merged AND the branch tip is the
// commit that pull request merged from, so a commit pushed after the merge is never lost.
// Anything uncertain is kept: no pull request, one that is open or was closed unmerged, a
// reopened branch, or a list this call could not read in full.
//
// Reads are live (ghFetch), not the cached reads the other tools use, because a stale list
// is how a branch with new work gets deleted. A confirmed call re-reads each branch's tip
// immediately before deleting it.

const PAGE_SIZE = 100;
const PAGE_CAP = 10;
// A confirmed call deletes at most this many, and says how many are left, so one call's
// subrequests stay bounded however many branches are stale. The seat repeats until none remain.
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
}

interface PruneKept {
  branch: string;
  reason: string;
}

interface PruneCandidate {
  branch: string;
  sha: string;
  pr: number;
}

type PruneVerdict = { prune: true; pr: number } | { prune: false; reason: string };

/** Whether a branch may be pruned, from the facts about it. Pure, so every rule is tested
 *  without GitHub. `latest` is the branch's newest pull request in this repo, or undefined. */
export function pruneVerdict(
  branch: { name: string; sha: string; protected: boolean },
  defaultBranch: string,
  latest: { number: number; state: string; merged: boolean; headSha: string } | undefined,
  listsComplete: boolean
): PruneVerdict {
  if (branch.name === defaultBranch) return { prune: false, reason: "default branch" };
  if (branch.protected) return { prune: false, reason: "protected branch" };
  if (NEVER_PRUNED.has(branch.name) || NEVER_PRUNED_PREFIXES.some((p) => branch.name.startsWith(p))) {
    return { prune: false, reason: "kept by name (release, screenshots, results, gh-pages)" };
  }
  if (isImproveBranch(branch.name)) return { prune: false, reason: "improve loop branch" };
  if (!latest) {
    return { prune: false, reason: listsComplete ? "no pull request" : "no pull request found in the part of the list that was read" };
  }
  if (latest.state === "open") return { prune: false, reason: `open pull request #${latest.number}` };
  if (!latest.merged) return { prune: false, reason: `pull request #${latest.number} was closed without merging` };
  if (latest.headSha !== branch.sha) return { prune: false, reason: `commits after pull request #${latest.number} merged` };
  return { prune: true, pr: latest.number };
}

async function paged<T>(env: Env, owner: string, repo: string, path: string): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const resp = await ghFetch(env, owner, repo, `${path}${sep}per_page=${PAGE_SIZE}&page=${page}`);
    if (!resp.ok) throw new Error(`delete_branch merged: reading ${path} failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    const batch = (await resp.json()) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

export async function pruneMergedBranches(env: Env, namespace: string, opts: { confirm?: boolean } = {}, repoSelector?: string) {
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const base = `/repos/${owner}/${repo}`;
  const defaultBranch = await getDefaultBranch(env, owner, repo);

  const branches = await paged<BranchRow>(env, owner, repo, `${base}/branches`);
  const open = await paged<PullRow>(env, owner, repo, `${base}/pulls?state=open`);
  const closed = await paged<PullRow>(env, owner, repo, `${base}/pulls?state=closed&sort=updated&direction=desc`);
  const listsComplete = branches.complete && open.complete && closed.complete;

  // The newest pull request per head branch, from this repo only: a fork's pull request can
  // carry a head branch of the same name.
  const latest = new Map<string, { number: number; state: string; merged: boolean; headSha: string }>();
  for (const pr of [...open.rows, ...closed.rows]) {
    if (pr.head.repo?.full_name?.toLowerCase() !== full.toLowerCase()) continue;
    const seen = latest.get(pr.head.ref);
    if (!seen || pr.number > seen.number) {
      latest.set(pr.head.ref, { number: pr.number, state: pr.state, merged: pr.merged_at !== null, headSha: pr.head.sha });
    }
  }

  const prune: PruneCandidate[] = [];
  const kept: PruneKept[] = [];
  for (const b of branches.rows) {
    const verdict = pruneVerdict({ name: b.name, sha: b.commit.sha, protected: b.protected === true }, defaultBranch, latest.get(b.name), listsComplete);
    if (verdict.prune) prune.push({ branch: b.name, sha: b.commit.sha, pr: verdict.pr });
    else kept.push({ branch: b.name, reason: verdict.reason });
  }

  const result = {
    repo: full,
    mode: opts.confirm ? ("delete" as const) : ("preview" as const),
    branches_read: branches.rows.length,
    lists_complete: listsComplete,
    would_prune: prune.length,
    kept_count: kept.length,
    kept: kept.slice(0, KEPT_LISTED),
    kept_truncated: kept.length > KEPT_LISTED,
    prune,
    deleted: [] as string[],
    skipped: [] as PruneKept[],
    remaining: 0,
  };
  if (!opts.confirm) return result;

  const batch = prune.slice(0, DELETE_CAP);
  for (const c of batch) {
    // The tip as it is now. A branch that moved since the list was read has new work.
    let tip: string | undefined;
    try {
      const ref = await ghFetch(env, owner, repo, `${base}/git/ref/heads/${encodePath(c.branch)}`);
      if (ref.ok) tip = ((await ref.json()) as { object?: { sha?: string } }).object?.sha;
    } catch {
      tip = undefined;
    }
    if (tip === undefined) {
      result.skipped.push({ branch: c.branch, reason: "could not re-read the branch tip, so it was not deleted" });
      continue;
    }
    if (tip !== c.sha) {
      result.skipped.push({ branch: c.branch, reason: "the branch moved since the preview, so it was not deleted" });
      continue;
    }
    const resp = await ghFetch(env, owner, repo, `${base}/git/refs/heads/${encodePath(c.branch)}`, { method: "DELETE" });
    if (resp.ok || resp.status === 404 || resp.status === 422) {
      if (resp.ok) result.deleted.push(c.branch);
      else result.skipped.push({ branch: c.branch, reason: `already gone (${resp.status})` });
    } else {
      result.skipped.push({ branch: c.branch, reason: `GitHub refused the delete (${resp.status})` });
    }
  }
  result.remaining = prune.length - batch.length;
  await invalidateRepoReads(env, owner, repo);
  return result;
}
