import assert from "node:assert/strict";
import { test } from "node:test";
import { docPath, MAX_PATH, pathProblem, resultRef, resultRefProblem } from "../src/limits.ts";
import {
  CI_DISPATCH_POLL_INTERVAL_MS,
  CI_DISPATCH_POLL_MS,
  CI_LOG_BUDGET,
  REPO_HISTORY_DEFAULT_LIMIT,
  REPO_HISTORY_MAX_LIMIT,
} from "../src/github.ts";
import { sourceFiles } from "./source-files.ts";

// src/limits.ts: the document path grammar and the input bounds.
//
// This file used to hold five unrelated subjects (quality audit 6.6): the path
// grammar, timingSafeEqual, the encoders, the REPORT_PREFIX dedupe and the
// confirmation wiring. It was named after one of them, so four of the five were
// findable only by reading it. They now live with the module they describe:
// timingSafeEqual in auth.test.ts, the encoders in encoding.test.ts, and the
// "one definition, imported rather than re-typed" guards in
// source-conventions.test.ts.

test("the grammar accepts the paths the store actually holds", () => {
  // Shapes measured in the live store on 2026-08-17, including the longest path
  // (83 chars) and the archive/ prefix that 219 of 536 documents carry.
  for (const path of [
    "core.md",
    "conventions.md",
    "archive/session-2026-08-11-foxhound-ci-migrations-turnstile-and-the-staging-name.md",
    "recova/parity/INVENTORY-SEED.md",
    "a.md",
  ]) {
    assert.equal(pathProblem(path), null, `${path} was rejected`);
  }
});

test("the grammar refuses traversal, absolutes, control characters and empties", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /must not be empty/],
    ["/etc/passwd", /must not start/],
    ["notes/", /must not end/],
    ["../secrets.md", /must not contain '\.\.'/],
    ["a/../../b.md", /must not contain '\.\.'/],
    ["a//b.md", /empty segment/],
    ["a\nb.md", /control characters/],
    ["a\tb.md", /control characters/],
    [`a${String.fromCharCode(0)}b.md`, /control characters/],
    [`a${String.fromCharCode(127)}b.md`, /control characters/],
    [`${"x".repeat(MAX_PATH + 1)}.md`, /longer than/],
  ];
  for (const [path, expected] of cases) {
    const problem = pathProblem(path);
    assert.ok(problem, `${JSON.stringify(path)} was accepted`);
    assert.match(problem, expected);
  }
});

test("the zod schema carries the same grammar, with the reason", () => {
  // The schema and the function must not be able to disagree: every tool argument
  // goes through the schema, and only the function is unit-testable.
  assert.equal(docPath.safeParse("archive/note.md").success, true);
  const bad = docPath.safeParse("../escape.md");
  assert.equal(bad.success, false);
  assert.match(bad.error?.issues[0]?.message ?? "", /must not contain '\.\.'/);
});

// src/limits.ts is where `bounded` and `docPath` are BUILT, so it is the one file
// that must contain a bare z.string(), and the scan below exempts it.
const BARE_Z_STRING = /z\.string\(\)/;
const isComment = (line: string) => line.startsWith("//") || line.startsWith("*");

// scanner-rule: quality audit 1.1, every tool argument is bounded
test("every tool argument is bounded: no bare z.string() anywhere in src/", () => {
  // Widened from server.ts to the whole directory (quality audit 1.1). An
  // unbounded field is unbounded wherever it is declared, and the day a tool
  // schema is written in another module a server.ts-only scan reports green over
  // a surface it never read.
  //
  // Widening it made the rule state itself for the first time. Scanning one file,
  // it never had to say what "bare z.string()" excludes; over the whole directory
  // it does, and the answer is: not a comment, and not the two primitives in
  // limits.ts that the rule is built out of.
  const offenders = sourceFiles()
    .filter((f) => f.name !== "limits.ts")
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !isComment(l.text) && BARE_Z_STRING.test(l.text))
    );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "an unbounded z.string() is back; use bounded(...) from src/limits.ts"
  );
  // Vacuity guards: the scan has to be looking at real schemas, and at the
  // grammar being wired up, or "no offenders" means "nothing was read".
  const all = sourceFiles().map((f) => f.text).join("\n");
  assert.ok(all.includes("bounded(MAX_BODY)"), "the scan matched nothing, so it proves nothing");
  assert.ok(all.split("docPath").length - 1 >= 8, "docPath is barely used, so the grammar is probably not wired up");
});

// ---- the repo fallthrough's bounds: how they relate to each other --------------

test("the CI log budget is larger than the tail it replaced", () => {
  // It replaced a 2000-character job tail. Smaller than that would be a regression
  // dressed as a ruling, so the relationship is asserted rather than assumed.
  assert.ok(CI_LOG_BUDGET > 2000, "the new budget is smaller than the tail it replaced");
});

test("the history default limit is below the maximum", () => {
  assert.ok(REPO_HISTORY_DEFAULT_LIMIT < REPO_HISTORY_MAX_LIMIT, "the default is not below the maximum");
});

test("the ci_dispatch poll fits inside its own timeout with room for several polls", () => {
  // At least a few polls must fit, or the timeout is a single attempt.
  assert.ok(CI_DISPATCH_POLL_MS / CI_DISPATCH_POLL_INTERVAL_MS >= 5, "too few polls fit in the timeout");
});

// ---- result_ref: a document key OR a PR URL -----------------------------------
//
// The jobs tool's own description has advertised "a document key or a PR URL"
// since the queue shipped, and the field was wired to `docPath`, which refuses
// every URL on the '//' after the scheme. Two jobs recorded the defect in their
// result_summary rather than in a result_ref, which is the measurement: the field
// was unusable for exactly the value it names. Fixed 2026-09-11.

test("result_ref takes the shapes the queue actually reports", () => {
  for (const ref of [
    "https://github.com/DrDustinEdwards/capsid-mcp/pull/13",
    "https://github.com/DrDustinEdwards/capsid-mcp/pull/13#issuecomment-1",
    "capsid/jobs/job_7d6aebd1e183.md",
    "capsid-mcp/fe48a068efafca372fe1787e07810e4425549ab9",
    "DrDustinEdwards/capsid-mcp/pull/13",
  ]) {
    assert.equal(resultRefProblem(ref), null, `${ref} was rejected`);
  }
});

test("result_ref refuses a non-https scheme, credentials and the path grammar's escapes", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /must not be empty/],
    // The scheme that makes a rendered link executable. The mirror document puts
    // this value in front of a human who may click it.
    ["javascript:alert(1)", /must not contain '\.\.'|https/],
    ["http://github.com/a/b/pull/1", /https/],
    // Credentials in a URL are a phishing shape, not a reference.
    ["https://user:pass@github.com/a/b/pull/1", /credentials/],
    ["https://", /not a valid URL|host/],
    ["../secrets.md", /must not contain '\.\.'/],
    ["a\nb.md", /control characters/],
    [`https://github.com/${"x".repeat(MAX_PATH)}`, /longer than/],
  ];
  for (const ref of cases) {
    const problem = resultRefProblem(ref[0]);
    assert.ok(problem, `${JSON.stringify(ref[0])} was accepted`);
    assert.match(problem, ref[1]);
  }
});

test("the result_ref zod schema carries the same grammar, with the reason", () => {
  assert.equal(resultRef.safeParse("https://github.com/DrDustinEdwards/capsid-mcp/pull/13").success, true);
  const bad = resultRef.safeParse("http://github.com/a/b/pull/1");
  assert.equal(bad.success, false);
  assert.match(bad.error?.issues[0]?.message ?? "", /https/);
});
