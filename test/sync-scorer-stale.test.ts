import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - a .mjs script with no type declarations, driven here for real.
import { requireCurrent } from "../scripts/sync-scorer.mjs";

// A CLONE THAT HAS NEVER FETCHED AGREES WITH ITSELF AND WITH NOTHING ELSE.
//
// requireCurrent compared the local ref to its own remote-tracking branch and stopped
// there. That cannot see the case it exists for: when origin/<ref> is ITSELF stale,
// both sides are the same old commit and the check passes.
//
// Measured 2026-09-18 on foxhound. Its clone had never been fetched, so `main` and
// `origin/main` were both 826b67f while the real remote was at 3360275, one merged
// sync PR ahead. The check passed, the copier read the stale blobs, and the dry run
// reported foxhound's scorer as diverged from capsid's. It was not: all five repos
// were byte-identical on their actual remotes. job_63f96b1d1a32 was posted to
// investigate a divergence that never existed.
//
// These build that exact shape with real git rather than describing it.

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
  // ONE FIXTURE, TWO ASSERTIONS, because each one costs a bare init and two clones and
  // this file runs inside the unit suite's 60-second budget.
  const { root, stale } = staleClone();
  try {
    // Non-vacuity first: the OLD check passes on this clone. If these ever differ, the
    // shape being guarded is not the shape this builds and the guard below would pass
    // for the wrong reason.
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
  // Both directions on one fixture. The innocent case matters: a guard that refuses
  // the ordinary run becomes a guard somebody removes. The unreachable case is the
  // answer to the original no-network design: it fails CLOSED and names the reason,
  // rather than falling back to two local refs that agree only with each other.
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
