import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PATH, pathProblem, resultRefProblem } from "../src/limits.ts";
import {} from "../src/github.ts";
import { sourceFiles } from "./source-files.ts";

test("the grammar accepts the paths the store actually holds", () => {
  for (const path of [
    "core.md",
    "conventions.md",
    "archive/session-2026-08-11-examples-ci-migrations-turnstile-and-the-staging-name.md",
    "sample/parity/INVENTORY-SEED.md",
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
    ["Archive/notes.md", /archive prefix exactly/],
  ];
  for (const [path, expected] of cases) {
    const problem = pathProblem(path);
    assert.ok(problem, `${JSON.stringify(path)} was accepted`);
    assert.match(problem, expected);
  }
});

// src/limits.ts is where `bounded` and `docPath` are BUILT, so it is the one file
// that must contain a bare z.string(), and the scan below exempts it.
const BARE_Z_STRING = /z\.string\(\)/;
const isComment = (line: string) => line.startsWith("//") || line.startsWith("*");

// scanner-rule: quality audit 1.1, every tool argument is bounded
test("every tool argument is bounded: no bare z.string() anywhere in src/", () => {
  // The whole directory, because a schema can be declared in any module; excluded are comments,
  // limits.ts's own primitives and the output schemas, which describe answers, not arguments.
  const offenders = sourceFiles()
    .filter((f) => f.name !== "limits.ts" && !f.name.startsWith("tools/outputs"))
    .flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
        .filter((l) => !isComment(l.text) && BARE_Z_STRING.test(l.text)),
    );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "an unbounded z.string() is back; use bounded(...) from src/limits.ts",
  );
  // Vacuity guards: the scan has to be looking at real schemas, and at the
  // grammar being wired up, or "no offenders" means "nothing was read".
  const all = sourceFiles()
    .map((f) => f.text)
    .join("\n");
  assert.ok(all.includes("bounded(MAX_BODY)"), "the scan matched nothing, so it proves nothing");
  assert.ok(
    all.split("docPath").length - 1 >= 8,
    "docPath is barely used, so the grammar is probably not wired up",
  );
});

// result_ref: a document key or a PR URL. `docPath` alone would refuse every URL on
// the '//' after the scheme.

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
    // The mirror document shows this value to a human who may click it.
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
