import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TARGETS, requireLanded, requireRemoteCurrent } from "../scripts/sync-scorer.mjs";

// THE REF THE COPIER READ WAS NOT THE REF THE REPO RUNS.
//
// test/sync-scorer-stale.test.ts covers a clone that is behind its remote. This
// covers the case one step further out, where the clone is perfectly current and the
// ref being compared is simply the wrong one.
//
// Measured 2026-09-18, job_3bde47744566. dustinedwards-info was compared at
// improve/capsid, the rollout branch the copier's own last run had written, so it
// reported identical while main ran a comment-stripped scripts/improve-report.mjs
// (a696dd63 against 6ab6cc8c). The watcher, which reads default branches, saw the
// drift the copier could not. Comparing a copier against its own output agrees by
// construction and proves nothing.
//
// The branch was also 64 commits behind main by then, so writing the fix into it
// would have based the fix on a stale tree. Both halves are guarded here with real
// git rather than described.

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A bare remote with main at two commits and a rollout branch left at the first,
 *  plus a clone of it with the rollout branch checked out. */
function rollout() {
  const root = mkdtempSync(join(tmpdir(), "sync-scorer-runs-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const use = join(root, "use");

  execFileSync("git", ["init", "--bare", "-b", "main", remote], { encoding: "utf8" });
  execFileSync("git", ["clone", remote, work], { encoding: "utf8" });
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");

  const commit = (body: string, message: string) => {
    writeFileSync(join(work, "a.txt"), body);
    git(work, "add", "a.txt");
    git(work, "commit", "-m", message);
  };

  commit("one\n", "one");
  git(work, "push", "origin", "main");
  git(work, "branch", "rollout");
  git(work, "push", "origin", "rollout");

  // main moves on. The rollout branch does not.
  commit("two\n", "two");
  git(work, "push", "origin", "main");

  execFileSync("git", ["clone", remote, use], { encoding: "utf8" });
  git(use, "config", "user.email", "t@example.com");
  git(use, "config", "user.name", "t");
  git(use, "checkout", "rollout");

  return { root, work, use, commit };
}

test("A ROLLOUT BRANCH BEHIND WHAT IT MERGES INTO IS REFUSED, and the refusal names the merge", () => {
  // ONE FIXTURE, FOUR ASSERTIONS. Each fixture costs a bare init and two clones, and
  // this file runs inside the unit suite's 60-second budget.
  const { root, work, use, commit } = rollout();
  try {
    // Non-vacuity: the branch really is behind, so the refusal below is the guard
    // firing rather than an error thrown for some other reason.
    assert.equal(git(use, "rev-list", "--count", "rollout..origin/main"), "1");
    assert.throws(
      () => requireLanded(use, "rollout", "main", "under-test"),
      (err: Error) => {
        assert.match(err.message, /1 commit\(s\) behind origin\/main/);
        assert.match(err.message, /merge origin\/main/);
        assert.match(err.message, /Nothing was written/);
        return true;
      },
      "a rollout branch behind its default branch was accepted as a place to write"
    );

    // The innocent case: once the branch carries main, writing into it is sound. A
    // guard that refuses the ordinary run is a guard somebody deletes.
    git(use, "merge", "origin/main", "-m", "merge main");
    requireLanded(use, "rollout", "main", "under-test");

    // AND THE COMPARE REF IS CHECKED AGAINST THE REMOTE, NOT AGAINST THE CLONE.
    // main here is owned by somebody else and cannot be moved from this tree, so
    // only the remote-tracking ref is asked, and it is asked of the remote.
    requireRemoteCurrent(use, "main", "under-test");
    commit("three\n", "three");
    git(work, "push", "origin", "main");
    assert.throws(
      () => requireRemoteCurrent(use, "main", "under-test"),
      (err: Error) => {
        assert.match(err.message, /has not fetched/);
        assert.match(err.message, /no longer runs/);
        return true;
      },
      "a stale remote-tracking ref was read as what the repo runs"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the dustinedwards target compares the branch it RUNS, not the branch it writes", () => {
  // Ruling 60 sends the write to a rollout branch in the worktree. Nothing sends the
  // COMPARISON there, and collapsing the two back into one ref restores the defect.
  const dustin = TARGETS.find((t) => /dustinedwards/.test(t.label));
  assert.ok(dustin, "no dustinedwards target at all; the rollout would silently skip it");
  assert.equal(dustin.ref, "improve/capsid", "the write branch is not the ruling 60 branch");
  assert.equal(dustin.runs, "main", "the dustinedwards target does not compare against its default branch");
});

test("every other target writes what it runs, and a runs ref is never the write ref", () => {
  for (const t of TARGETS) {
    if (t.runs === undefined) continue;
    assert.notEqual(t.runs, t.ref, `${t.label} sets runs to the ref it writes, which compares the copier with itself`);
  }
  const split = TARGETS.filter((t) => t.runs !== undefined).map((t) => t.label);
  assert.equal(split.length, 1, `expected exactly one target whose write branch differs from what it runs, found ${split.join(", ")}`);
});
