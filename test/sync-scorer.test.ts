import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { MARKER, SOURCE_ROOT, TARGETS, blockHash, normalize, splitBlock } from "../scripts/sync-scorer.mjs";

// THE HALF OF THE IDENTITY GUARD THAT CAN RUN OFFLINE (2026-09-10).
//
// The score job and scripts/improve-report.mjs are byte-identical across all five
// roster repos. Nothing enforced that, and on 2026-09-10 a comment pass rewrote
// this repo's copies and the four others silently diverged into three variants.
//
// SCOPE, STATED RATHER THAN IMPLIED: the other four repos are not on disk in CI,
// so this file cannot compare their blobs, and a test that pretended to would be
// asserting nothing. What it pins is the split scripts/sync-scorer.mjs performs,
// because every copy the sync writes is decided by that split: a marker that moved,
// appeared twice, or vanished would send the wrong bytes to four repos that deploy
// on merge. The cross-repo comparison is the sync's own dry run, against clones.

const WORKFLOW_PATH = join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

test("the marker occurs exactly once in this repo's own score workflow", () => {
  const hits = normalize(workflow)
    .split("\n")
    .filter((line) => line.includes(MARKER));
  assert.equal(hits.length, 1, `expected one ${MARKER} line, found ${hits.length}`);
});

test("the split is lossless: head and tail reassemble the file byte for byte", () => {
  const { head, tail } = splitBlock(workflow, "improve-score.yml");
  assert.equal(`${head}\n${tail}`, normalize(workflow));
});

// A count check beside the content check, so "the block looks fine" cannot pass by
// reading nothing (capsid/conventions.md, self-enforcing checks).
test("the tail is the shared block: it starts at the marker and carries the score job", () => {
  const { tail } = splitBlock(workflow, "improve-score.yml");
  const lines = tail.split("\n");
  assert.ok(lines[0].includes(MARKER), "the tail must begin with the marker line");
  assert.ok(lines.length > 100, `the shared block should be substantial, got ${lines.length} lines`);
  assert.ok(/^\s{2}score:$/m.test(tail), "the score job must live inside the shared block");
  assert.ok(!/^\s{2}build:$/m.test(tail), "the per-repo build job must stay above the marker");
});

test("the diagnostics restored on 2026-09-10 are inside the shared block", () => {
  const { tail } = splitBlock(workflow, "improve-score.yml");
  // Ruled by the seat 2026-09-10: these are diagnostics, not slop, and a comment
  // pass never removes executable lines. Copied to four repos, so they belong to
  // the shared block rather than to any one repo.
  for (const line of ['echo "container exited $?"', 'tail -5 "${RUNNER_TEMP}/holdout.err"', 'echo "holdout ${PASSED} of ${TOTAL}"', 'echo "${BODY}"']) {
    assert.ok(tail.includes(line), `the score job must keep its diagnostic: ${line}`);
  }
});

test("blockHash is stable and independent of line endings", () => {
  const { tail } = splitBlock(workflow, "improve-score.yml");
  assert.equal(blockHash(tail), blockHash(tail));
  assert.equal(blockHash(tail), blockHash(tail.replace(/\n/g, "\r\n")));
  assert.match(blockHash(tail), /^[0-9a-f]{64}$/);
});

test("splitBlock refuses a missing marker", () => {
  assert.throws(() => splitBlock("jobs:\n  build:\n    runs-on: ubuntu-latest\n", "no-marker.yml"), /marker found 0 times/);
});

test("splitBlock refuses a duplicate marker, rather than guessing a split point", () => {
  const doubled = `# ${MARKER}\nscore:\n# ${MARKER}\n`;
  assert.throws(() => splitBlock(doubled, "doubled.yml"), /marker found 2 times/);
});

// ---- the copier's own configuration ----------------------------------------
//
// Nothing here resolved a path until 2026-09-16, and the copier had been dead
// since 4c1a089 on 2026-09-12: that commit renamed every mention of the
// repository from capsid-mcp to capsid, including the SOURCE DIRECTORY, but the
// clone stays at dev/capsid-mcp deliberately. The first git call threw, and no
// test noticed because no test looked.

test("the copier's source resolves to THIS repository, whatever it is named", () => {
  // Derived from the script's own location, so a rename cannot point it at a
  // directory that does not exist. Checked by looking for the two files the
  // copier reads, which is the assertion that would have gone red on 2026-09-12.
  assert.ok(existsSync(SOURCE_ROOT), `the copier's source does not exist: ${SOURCE_ROOT}`);
  assert.ok(existsSync(join(SOURCE_ROOT, "package.json")), `${SOURCE_ROOT} is not a repository root`);
  assert.ok(
    existsSync(join(SOURCE_ROOT, ".github", "workflows", "improve-score.yml")),
    "the copier's source has no scorer workflow to copy"
  );
  assert.ok(existsSync(join(SOURCE_ROOT, "scripts", "improve-report.mjs")), "the copier's source has no report script to copy");
});

test("THE COPIER NEVER WRITES INTO THE dustinedwards-info CLONE (ruling 60)", () => {
  // Ruling 60: every rollout the Capsid seat makes to that repo runs in the
  // worktree on improve/capsid, never in the clone, because the site session owns
  // the clone and main. The target list named the clone, so --apply would have
  // written straight into it.
  assert.equal(TARGETS.length, 4, `expected 4 targets, found ${TARGETS.length}; the list is not the one this guard read`);
  const offenders = TARGETS.filter((t) => basename(t.dir) === "dustinedwards-info").map((t) => t.dir);
  assert.deepEqual(offenders, [], "a target points at the dustinedwards-info clone; ruling 60 requires the worktree");
  const dustin = TARGETS.find((t) => /dustinedwards/.test(t.label));
  assert.ok(dustin, "no dustinedwards target at all; the rollout would silently skip it");
  // Compared with path functions, not a regex: a separator class is one escaping
  // slip away from matching only forward slashes and passing on every Windows path.
  assert.equal(basename(dustin.dir), "capsid", "the dustinedwards target is not the ruling 60 worktree");
  assert.equal(basename(dirname(dustin.dir)), "worktrees", "the dustinedwards target is not under worktrees/");
  assert.equal(dustin.ref, "improve/capsid", "the dustinedwards target is not on the ruling 60 branch");
});

test("every target is an absolute path with a ref and a label", () => {
  for (const t of TARGETS) {
    assert.ok(isAbsolute(t.dir), `target ${t.label} is not an absolute path: ${t.dir}`);
    assert.ok(t.ref.length > 0, `target ${t.dir} has no ref`);
    assert.ok(t.label.length > 0, `target ${t.dir} has no label`);
  }
});
