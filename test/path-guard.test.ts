import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { servedProtectedPaths } from "../src/improve-schema.ts";

// scripts/path-guard.mjs, RUN AS THE DRIVER RUNS IT, against a real git repository.
//
// The guard used to read a file of paths the driver produced with
// `git diff --name-only <base>..HEAD > changed.txt`. Three inputs got past it:
// a rename printed only its new path, so a protected file moved out of test/ was
// never checked; core.quotePath printed a non-ASCII path C-quoted, starting with a
// double quote, so no anchored pattern matched; and a failed diff still created an
// empty file, which the guard reported as "changed no files" and passed. The guard
// now runs the diff itself with --no-renames -z, and these tests drive that.
//
// One repository serves every case: each case starts from a detached checkout of
// the base commit, because a git call costs seconds on a Windows host.

const SCRIPT = join(import.meta.dirname, "..", "scripts", "path-guard.mjs");

let dir = "";
let base = "";
let served = "";

function git(args: string[], input?: string): string {
  // core.protectNTFS=false lets a double quote into a committed path on Windows,
  // which is how the quoted-path case is planted.
  const config = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.protectNTFS=false"];
  const result = spawnSync("git", [...config, ...args], { cwd: dir, encoding: "utf8", input });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "path-guard-"));
  git(["init", "-q"]);
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "test", "x.test.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  base = git(["rev-parse", "HEAD"]);
  served = join(dir, ".git", "protected.json");
  writeFileSync(served, JSON.stringify(servedProtectedPaths()));
});

after(() => rmSync(dir, { recursive: true, force: true }));

function fromBase(): void {
  git(["checkout", "-q", "--detach", base]);
}

function guard(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Commits a file through the index alone, so a path the filesystem cannot hold (a
// double quote on Windows) can still be committed.
function commitPathViaIndex(path: string): void {
  const blob = git(["hash-object", "-w", "--stdin"], "x\n");
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  git(["commit", "-q", "-m", "plant"]);
}

test("an ordinary change outside the protected paths passes", () => {
  fromBase();
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  git(["commit", "-q", "-am", "change"]);
  const r = guard([served, base, "HEAD"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 changed path\(s\), none protected/);
});

test("a rename OUT of a protected path is refused, because the old path is listed too", () => {
  fromBase();
  git(["mv", "test/x.test.ts", "src/x.ts"]);
  git(["commit", "-q", "-m", "move"]);
  // The plain --name-only listing the driver used to write shows only the new path.
  assert.equal(git(["diff", "--name-only", `${base}..HEAD`]), "src/x.ts");
  const r = guard([served, base, "HEAD"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /PROTECTED test\/x\.test\.ts/);
});

test("a protected path with a non-ASCII name is refused, not missed as a quoted string", () => {
  fromBase();
  commitPathViaIndex(".github/workflows/é.yml");
  const r = guard([served, base, "HEAD"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /PROTECTED \.github\/workflows\//);
});

test("a path that starts with a double quote is refused", () => {
  fromBase();
  commitPathViaIndex('"x.ts');
  const r = guard([served, base, "HEAD"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /double quote/);
});

test("a base ref git cannot resolve is a failure, not a pass", () => {
  const r = guard([served, "no-such-ref", "HEAD"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /git diff failed/);
});

test("an empty diff is a failure, not a pass", () => {
  const r = guard([served, base, base]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no changed paths/);
});

test("a ref that looks like an option is refused before git sees it", () => {
  const r = guard([served, "--output=x", "HEAD"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /starts with "-"/);
});
