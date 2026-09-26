import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requireLanded, requireRemoteCurrent } from "../scripts/sync-scorer.mjs";

// The ref the copier compares must be the ref the repo runs.
//
// test/sync-scorer-stale.test.ts covers a clone that is behind its remote. This
// covers a current clone comparing the wrong ref: a rollout branch the copier wrote
// itself agrees with the copier by construction, while the default branch may run
// something else. A rollout branch behind the default branch is also a stale base to
// write into. Both halves are driven with real git.

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
  // One fixture, four assertions: each fixture costs a bare init and two clones, and
  // this file runs inside the unit suite's time budget.
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

    // The innocent case: once the branch carries main, writing into it is sound.
    git(use, "merge", "origin/main", "-m", "merge main");
    requireLanded(use, "rollout", "main", "under-test");

    // The compare ref is checked against the remote, not against the clone.
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
