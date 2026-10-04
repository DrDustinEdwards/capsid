import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - a .mjs script with no type declarations, driven here for real.
import { checkRange, isAgentIdentity, rangeFromEvent, trailerViolations } from "../scripts/check-commit-trailers.mjs";

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
  // Authors are checked on a pull request only: the push path is as it was.
  assert.deepEqual(rangeFromEvent({ EVENT: "pull_request", PR_BASE: "a", PR_HEAD: "b" }), { base: "a", head: "b", authors: true });
  assert.deepEqual(rangeFromEvent({ EVENT: "push", PUSH_BEFORE: "a", PUSH_AFTER: "b" }), { base: "a", head: "b", authors: false });
  assert.deepEqual(rangeFromEvent({ EVENT: "push", PUSH_BEFORE: "0000000000000000000000000000000000000000", PUSH_AFTER: "b" }), { base: null, head: "b", authors: false });
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

// The author check. A squash merge builds its message from the branch commits' authors, so
// a clean message authored as Claude becomes "Co-authored-by: Claude" on master, and the
// push run then fails after the merge (2026-10-04, PRs 233 to 236).

test("an AI identity is Anthropic's address, claude[bot], or the name Claude with a product word; a person is not", () => {
  for (const [name, email] of [
    ["Claude", "noreply@anthropic.com"],
    ["Claude", "someone@example.com"],
    ["claude", "x@example.com"],
    ["Claude Code", "x@example.com"],
    ["Claude Opus 4.5", "x@example.com"],
    ["Someone", "agent@anthropic.com"],
    ["Someone", "agent@mail.anthropic.com"],
    ["claude[bot]", "209825114+claude[bot]@users.noreply.github.com"],
    ["Someone", "209825114+claude[bot]@users.noreply.github.com"],
    ["Anthropic Bot", "x@example.com"],
  ]) {
    assert.equal(isAgentIdentity(name, email), true, `${name} <${email}>`);
  }
  for (const [name, email] of [
    ["Dustin Edwards", "dustin@example.com"],
    ["Claude Dupont", "claude.dupont@example.com"],
    ["claude-skills deploy", "ci@example.com"],
    ["capsid-repo-access[bot]", "300661428+capsid-repo-access[bot]@users.noreply.github.com"],
    ["GitHub", "noreply@github.com"],
    ["renovate[bot]", "29139614+renovate[bot]@users.noreply.github.com"],
    ["Someone", "x@notanthropic.com"],
    ["", ""],
  ]) {
    assert.equal(isAgentIdentity(name, email), false, `${name} <${email}>`);
  }
});

test("PLANT: over a real repository, a clean message authored as Claude fails on the pull request path and passes on the push path", () => {
  const dir = mkdtempSync(join(tmpdir(), "trailers-authors-"));
  try {
    const git = (env: Record<string, string>, ...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
    const person = { GIT_AUTHOR_NAME: "Dustin Edwards", GIT_AUTHOR_EMAIL: "dustin@example.com", GIT_COMMITTER_NAME: "Dustin Edwards", GIT_COMMITTER_EMAIL: "dustin@example.com" };
    const commit = (env: Record<string, string>, message: string) => {
      writeFileSync(join(dir, "f.txt"), message + Math.random());
      git(env, "add", "f.txt");
      git(env, "commit", "-q", "-m", message);
      return git(env, "rev-parse", "HEAD");
    };
    git(person, "init", "-q");
    const base = commit(person, "Clean base");
    // A pre-range commit authored as Claude is history and is not checked.
    const dustin = commit(person, BODY);
    const authoredAsClaude = commit({ ...person, GIT_AUTHOR_NAME: "Claude", GIT_AUTHOR_EMAIL: "noreply@anthropic.com" }, BODY);
    const committedAsClaude = commit({ ...person, GIT_COMMITTER_NAME: "Claude", GIT_COMMITTER_EMAIL: "noreply@anthropic.com" }, BODY);

    // The message is clean in all of them; only the identity differs.
    assert.deepEqual(trailerViolations(BODY), []);
    assert.deepEqual(checkRange(base, dustin, dir, true), [], "a Dustin-authored commit was refused");

    const asAuthor = checkRange(base, authoredAsClaude, dir, true);
    assert.equal(asAuthor.length, 1, JSON.stringify(asAuthor));
    assert.equal(asAuthor[0].sha, authoredAsClaude);
    assert.deepEqual(asAuthor[0].found, []);
    assert.deepEqual(asAuthor[0].identities, ["author Claude <noreply@anthropic.com>"]);

    const asCommitter = checkRange(authoredAsClaude, committedAsClaude, dir, true);
    assert.deepEqual(asCommitter[0].identities, ["committer Claude <noreply@anthropic.com>"]);

    // The push path is unchanged: the same commits pass when authors are not checked.
    assert.deepEqual(checkRange(base, authoredAsClaude, dir), []);
    assert.deepEqual(checkRange(base, committedAsClaude, dir, false), []);
    // A message trailer is still caught, with or without the author check.
    const trailer = commit(person, `${BODY}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
    assert.equal(checkRange(committedAsClaude, trailer, dir).length, 1);
    assert.equal(checkRange(committedAsClaude, trailer, dir, true)[0].found.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the script as CI runs it: a pull_request event with a Claude-authored commit exits 1 and says how to re-author; a push event exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "trailers-cli-"));
  try {
    const script = join(process.cwd(), "scripts", "check-commit-trailers.mjs");
    const env = { GIT_AUTHOR_NAME: "Claude", GIT_AUTHOR_EMAIL: "noreply@anthropic.com", GIT_COMMITTER_NAME: "Dustin Edwards", GIT_COMMITTER_EMAIL: "dustin@example.com" };
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
    git("init", "-q");
    writeFileSync(join(dir, "a"), "1");
    git("add", "a");
    git("commit", "-q", "-m", "Base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a"), "2");
    git("commit", "-q", "-am", "A clean message");
    const head = git("rev-parse", "HEAD");
    const run = (event: Record<string, string>) =>
      spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: { ...process.env, ...event } });

    const pr = run({ EVENT: "pull_request", PR_BASE: base, PR_HEAD: head });
    assert.equal(pr.status, 1, pr.stdout + pr.stderr);
    assert.match(pr.stderr, /has an AI identity \(author Claude <noreply@anthropic.com>\)/);
    assert.match(pr.stderr, /Co-authored-by: Claude/);
    assert.match(pr.stderr, /--reset-author/);

    const push = run({ EVENT: "push", PUSH_BEFORE: base, PUSH_AFTER: head });
    assert.equal(push.status, 0, push.stdout + push.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
