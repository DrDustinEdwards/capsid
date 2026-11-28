import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PATH, pathProblem } from "../src/limits.ts";
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
});
