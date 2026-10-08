import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneMergedBranches, pruneVerdict } from "../src/github.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// delete_branch with merged:true (job_8779278b8e91). A branch is pruned only when its latest
// pull request merged AND its tip is the commit that pull request merged from. Every keep
// below is a planted case beside the one branch that must go.

const ONE_REPO = [{ repo: "o/r", label: "primary" }];
const REPO_META = { body: { default_branch: "main" } };

function makeEnv() {
  return fakeEnv({
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify(ONE_REPO) }) }) }) },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const SAME_REPO = { full_name: "o/r" };
const pr = (number: number, ref: string, sha: string, o: { state?: string; merged?: boolean; repo?: { full_name: string } | null } = {}) => ({
  number,
  state: o.state ?? "closed",
  merged_at: o.merged === false || o.state === "open" ? null : "2026-10-01T00:00:00Z",
  head: { ref, sha, repo: o.repo === undefined ? SAME_REPO : o.repo },
});

const BRANCHES = [
  { name: "main", commit: { sha: "m1" } },
  { name: "feat/merged-clean", commit: { sha: "a1" } },
  { name: "feat/merged-then-more", commit: { sha: "a2-after" } },
  { name: "feat/open", commit: { sha: "o1" } },
  { name: "feat/closed-unmerged", commit: { sha: "c1" } },
  { name: "feat/reopened", commit: { sha: "r2" } },
  { name: "feat/forky", commit: { sha: "f1" } },
  { name: "release/1.0", commit: { sha: "x1" } },
  { name: "gh-pages", commit: { sha: "g1" } },
  { name: "stale/no-pr", commit: { sha: "n1" } },
  { name: "improve/attempt-1", commit: { sha: "i1" } },
  { name: "stable", commit: { sha: "s1" }, protected: true },
];
const OPEN = [pr(3, "feat/open", "o1", { state: "open" }), pr(6, "feat/reopened", "r2", { state: "open" })];
const CLOSED = [
  pr(1, "feat/merged-clean", "a1"),
  pr(2, "feat/merged-then-more", "a2"),
  pr(4, "feat/closed-unmerged", "c1", { merged: false }),
  pr(5, "feat/reopened", "r1"),
  pr(7, "feat/forky", "f1", { repo: { full_name: "fork/r" } }),
  pr(8, "improve/attempt-1", "i1"),
  pr(9, "stable", "s1"),
  pr(10, "release/1.0", "x1"),
];

function routes(tips: Record<string, string> = {}) {
  const r: Record<string, unknown> = {
    "GET /repos/o/r": REPO_META,
    "GET /repos/o/r/branches": { body: BRANCHES },
    "GET /repos/o/r/pulls": (_b: unknown, p: URLSearchParams) => ({ body: p.get("state") === "open" ? OPEN : CLOSED }),
  };
  for (const b of BRANCHES) {
    r[`GET /repos/o/r/git/ref/heads/${b.name}`] = { body: { object: { sha: tips[b.name] ?? b.commit.sha } } };
    r[`DELETE /repos/o/r/git/refs/heads/${b.name}`] = { status: 204, text: "" };
  }
  return r as never;
}

test("the preview lists the one merged-clean branch, keeps every other with its reason, and deletes nothing", async () => {
  await withFetch(routes(), async (calls) => {
    const out = await pruneMergedBranches(makeEnv(), "ns");
    assert.equal(out.mode, "preview");
    assert.deepEqual(out.prune.map((p) => p.branch), ["feat/merged-clean"]);
    assert.equal(out.would_prune, 1);
    const reasons = Object.fromEntries(out.kept.map((k) => [k.branch, k.reason]));
    assert.match(reasons["feat/merged-then-more"], /commits after pull request #2 merged/);
    assert.match(reasons["feat/open"], /open pull request #3/);
    assert.match(reasons["feat/closed-unmerged"], /closed without merging/);
    assert.match(reasons["feat/reopened"], /open pull request #6/, "the newest pull request decides, so a reopened branch is kept");
    assert.match(reasons["feat/forky"], /no pull request/, "a fork's pull request of the same branch name is not this repo's");
    assert.match(reasons["release/1.0"], /kept by name/);
    assert.match(reasons["gh-pages"], /kept by name/);
    assert.match(reasons["stale/no-pr"], /no pull request/);
    assert.match(reasons["improve/attempt-1"], /improve loop/);
    assert.match(reasons["stable"], /protected/);
    assert.match(reasons["main"], /default branch/);
    assert.equal(out.lists_complete, true);
    assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "a preview must not write");
  });
});

test("confirm deletes the listed branch only, and says nothing remains", async () => {
  await withFetch(routes(), async (calls) => {
    const out = await pruneMergedBranches(makeEnv(), "ns", { confirm: true });
    assert.equal(out.mode, "delete");
    assert.deepEqual(out.deleted, ["feat/merged-clean"]);
    assert.deepEqual(out.skipped, []);
    assert.equal(out.remaining, 0);
    assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/repos/o/r/git/refs/heads/feat/merged-clean"]);
  });
});

test("a branch that gained a commit between the preview and the delete is skipped, not deleted", async () => {
  await withFetch(routes({ "feat/merged-clean": "a1-new-work" }), async (calls) => {
    const out = await pruneMergedBranches(makeEnv(), "ns", { confirm: true });
    assert.deepEqual(out.deleted, []);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0].reason, /moved since the preview/);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  });
});

test("pruneVerdict keeps anything it could not see in full, and prunes only a clean merged tip", () => {
  const b = { name: "feat/x", sha: "t1", protected: false };
  assert.deepEqual(pruneVerdict(b, "main", { number: 5, state: "closed", merged: true, headSha: "t1" }, true), { prune: true, pr: 5 });
  assert.equal(pruneVerdict(b, "main", { number: 5, state: "closed", merged: true, headSha: "t0" }, true).prune, false);
  const unseen = pruneVerdict(b, "main", undefined, false);
  assert.equal(unseen.prune, false);
  assert.match((unseen as { reason: string }).reason, /part of the list that was read/);
});
