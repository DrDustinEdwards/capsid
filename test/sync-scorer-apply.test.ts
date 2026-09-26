import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MARKER, REPORT, WORKFLOW, sync } from "../scripts/sync-scorer.mjs";

// --apply validates every target before it writes any, and writes only into a clean
// tree on the branch it checked. Built with real git, because what is tested is how
// the copier treats a working tree.

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const workflow = (head: string, block: string) => `${head}\n# ${MARKER}\n${block}\n`;

/** A repo with a bare origin, one commit holding both files, pushed and tracking. */
function repo(root: string, name: string, branch: string, wf: string, report: string): string {
  const remote = join(root, `${name}.git`);
  const work = join(root, name);
  execFileSync("git", ["init", "-q", "--bare", "-b", branch, remote]);
  execFileSync("git", ["init", "-q", "-b", branch, work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  git(work, "config", "core.autocrlf", "false");
  mkdirSync(dirname(join(work, WORKFLOW)), { recursive: true });
  mkdirSync(dirname(join(work, REPORT)), { recursive: true });
  writeFileSync(join(work, WORKFLOW), wf);
  writeFileSync(join(work, REPORT), report);
  git(work, "add", WORKFLOW, REPORT);
  git(work, "commit", "-q", "-m", "one");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", branch);
  return work;
}

test("a refusal on any target leaves every target unwritten, and a clean run writes them all", () => {
  // One fixture, three runs, because each repo costs two git inits and this file runs
  // inside the unit suite's 60-second budget.
  const root = mkdtempSync(join(tmpdir(), "sync-scorer-apply-"));
  try {
    const OLD_WF = workflow("target build job", "old block");
    const source = { dir: repo(root, "source", "main", workflow("source build job", "new block"), "new report\n"), ref: "main", label: "source" };
    const a = repo(root, "a", "main", OLD_WF, "old report\n");
    const b = repo(root, "b", "main", OLD_WF, "old report\n");
    const targets = [
      { dir: a, ref: "main", label: "a" },
      { dir: b, ref: "main", label: "b" },
    ];
    const quiet = () => {};

    // 1. b carries an uncommitted edit to a file the copier would overwrite.
    writeFileSync(join(b, REPORT), "somebody's unsaved work\n");
    assert.throws(
      () => sync({ source, targets, apply: true, log: quiet }),
      (err: Error) => {
        assert.match(err.message, /^b: uncommitted changes/);
        assert.match(err.message, /Nothing was written/);
        return true;
      }
    );
    assert.equal(readFileSync(join(a, WORKFLOW), "utf8"), OLD_WF, "a was written although b refused");
    assert.equal(readFileSync(join(b, REPORT), "utf8"), "somebody's unsaved work\n", "an uncommitted edit was overwritten");

    // 2. b is clean but has another branch checked out.
    git(b, "checkout", "-q", "--", REPORT);
    git(b, "checkout", "-q", "-b", "elsewhere");
    assert.throws(
      () => sync({ source, targets, apply: true, log: quiet }),
      (err: Error) => {
        assert.match(err.message, /^b: elsewhere is checked out, but the copier writes main/);
        return true;
      }
    );
    assert.equal(readFileSync(join(a, WORKFLOW), "utf8"), OLD_WF, "a was written although b refused");

    // 3. The innocent case: both clean and on the branch that was checked.
    git(b, "checkout", "-q", "main");
    assert.equal(sync({ source, targets, apply: true, log: quiet }), 2);
    for (const dir of [a, b]) {
      assert.equal(readFileSync(join(dir, WORKFLOW), "utf8"), workflow("target build job", "new block"));
      assert.equal(readFileSync(join(dir, REPORT), "utf8"), "new report\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
