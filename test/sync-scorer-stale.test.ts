import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requireCurrent } from "../scripts/sync-scorer.mjs";

// A clone that has never fetched agrees with itself and with nothing else.
//
// Comparing the local ref to its own remote-tracking branch cannot see a stale
// origin/<ref>: both sides are the same old commit, and the copier then reads stale
// blobs and reports a divergence that does not exist. These build that shape with
// real git.

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A bare remote, a clone of it, and a second commit pushed from elsewhere so the
 *  clone's remote-tracking ref is stale while agreeing with its own local branch. */
function staleClone() {
  const root = mkdtempSync(join(tmpdir(), "sync-scorer-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const stale = join(root, "stale");

  execFileSync("git", ["init", "--bare", "-b", "main", remote], { encoding: "utf8" });
  execFileSync("git", ["clone", remote, work], { encoding: "utf8" });
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "one");
  git(work, "push", "origin", "main");

  // The clone under test, taken at that first commit.
  execFileSync("git", ["clone", remote, stale], { encoding: "utf8" });

  // Somebody else moves the remote on. The stale clone is never told.
  writeFileSync(join(work, "a.txt"), "two\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "two");
  git(work, "push", "origin", "main");

  return { root, stale };
}

test("A CLONE THAT HAS NOT FETCHED IS REFUSED, and the refusal says to fetch", () => {
  // One fixture, two assertions: each fixture costs a bare init and two clones, inside
  // the unit suite's 60-second budget.
  const { root, stale } = staleClone();
  try {
    // Non-vacuity: a local-only comparison passes on this clone, so the fixture is the
    // shape being guarded.
    assert.equal(git(stale, "rev-parse", "main"), git(stale, "rev-parse", "origin/main"));
    assert.throws(
      () => requireCurrent(stale, "main", "under-test"),
      (err: Error) => {
        assert.match(err.message, /has not fetched/);
        assert.match(err.message, /fetch origin/);
        assert.match(err.message, /Nothing was written/);
        return true;
      },
      "a never-fetched clone was accepted as current with its remote"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fetched clone passes, and an unreachable remote refuses", () => {
  // Both directions on one fixture. A guard that refuses the ordinary run gets
  // removed; an unreachable remote fails closed and names the reason, rather than
  // falling back to two local refs that agree only with each other.
  const { root, stale } = staleClone();
  try {
    git(stale, "fetch", "origin");
    git(stale, "reset", "--hard", "origin/main");
    requireCurrent(stale, "main", "under-test");

    git(stale, "remote", "set-url", "origin", join(root, "does-not-exist.git"));
    assert.throws(
      () => requireCurrent(stale, "main", "under-test"),
      (err: Error) => {
        assert.match(err.message, /could not be reached|Nothing was written/);
        return true;
      },
      "an unreachable remote was treated as agreement"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
