import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - a .mjs script with no type declarations, driven here for real.
import { checkRange, rangeFromEvent, trailerViolations } from "../scripts/check-commit-trailers.mjs";

// CLAUDE.md, no AI trailer rule. The CI step runs scripts/check-commit-trailers.mjs
// over the commits a push or pull request adds. These drive the script's functions,
// and one test drives it over a real throwaway git repository.

const BODY = "Add a thing\n\nWhat it does, in a sentence.";

test("each named trailer form is refused, in any case", () => {
  for (const trailer of [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "co-authored-by: claude opus <noreply@anthropic.com>",
    "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
    "Generated with Claude Code",
    "Claude-Session: https://claude.ai/code/session_abc",
    "CLAUDE-SESSION: https://example.com/x",
  ]) {
    assert.equal(trailerViolations(`${BODY}\n\n${trailer}\n`).length, 1, trailer);
  }
});

test("any other trailer naming Claude or Anthropic is refused", () => {
  for (const trailer of ["Assisted-By: Claude", "Agent: anthropic/claude-opus", "Reviewed-by: Dustin\nX-Model: Claude"]) {
    assert.ok(trailerViolations(`${BODY}\n\n${trailer}\n`).length >= 1, trailer);
  }
});

test("THE INNOCENT DIRECTION: a message that only mentions Claude or CLAUDE.md passes", () => {
  for (const message of [
    BODY,
    "Cut CLAUDE.md to 11 rules\n\nCLAUDE.md now names each rule.",
    "Refuse the trailer\n\nA harness asked for a Claude trailer and the session refused it.",
    "Fix a path\n\nRefs: CLAUDE.md",
    "Fix a path\n\nCo-Authored-By: Dustin Edwards <dustin@example.com>",
    "One line only",
    "",
  ]) {
    assert.deepEqual(trailerViolations(message), [], message);
  }
});

test("the range comes from the event, and an event with no commits checks nothing", () => {
  assert.deepEqual(rangeFromEvent({ EVENT: "pull_request", PR_BASE: "a", PR_HEAD: "b" }), { base: "a", head: "b" });
  assert.deepEqual(rangeFromEvent({ EVENT: "push", PUSH_BEFORE: "a", PUSH_AFTER: "b" }), { base: "a", head: "b" });
  assert.deepEqual(rangeFromEvent({ EVENT: "push", PUSH_BEFORE: "0000000000000000000000000000000000000000", PUSH_AFTER: "b" }), { base: null, head: "b" });
  assert.equal(rangeFromEvent({ EVENT: "schedule" }), null);
  assert.equal(rangeFromEvent({ EVENT: "workflow_dispatch" }), null);
  // Fails closed: a pull_request or push without its shas is an error, not a pass.
  assert.throws(() => rangeFromEvent({ EVENT: "pull_request", PR_BASE: "a" }));
  assert.throws(() => rangeFromEvent({ EVENT: "push" }));
});

test("PLANT: over a real repository, only the new commit with a trailer is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "trailers-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Sample", "-c", "user.email=sample@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
    const commit = (message: string) => {
      writeFileSync(join(dir, "f.txt"), message);
      git("add", "f.txt");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q");
    // An old commit with a trailer, before the range, which is not checked.
    commit(`${BODY}\n\nClaude-Session: https://example.com/old`);
    const base = commit("Clean base");
    const clean = commit(BODY);
    const planted = commit(`${BODY}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);

    const bad = checkRange(base, planted, dir);
    assert.equal(bad.length, 1, JSON.stringify(bad));
    assert.equal(bad[0].sha, planted);
    assert.deepEqual(checkRange(base, clean, dir), []);
    // A push that creates the branch checks its head commit alone.
    assert.equal(checkRange(null, planted, dir).length, 1);
    // An unknown base fails closed rather than checking nothing.
    assert.throws(() => checkRange("1".repeat(40), planted, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
