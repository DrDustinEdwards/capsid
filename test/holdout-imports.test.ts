import assert from "node:assert/strict";
import { test } from "node:test";
import { holdoutImportRefusal, holdoutImportsPath, importedNames, parseImportsManifest } from "../scripts/improve-report.mjs";

// The holdout import manifest.
//
// improve/holdout/<ns>/imports.txt lists every name the hidden suite imports out of
// the repo's own source. The holdout is a consumer no scan in the repo can see, so
// without the list a dead-export pass can delete an export it depends on.
//
// test/lint/dead-exports.lint.ts owns the direction where a listed name counts as a
// caller. This file owns the parser and the refusal, which is what Job B runs.

// Builtin imports before the first relative one: a matcher that crosses statement
// boundaries would report `assert`, `from` and `import` as imported names.
const REALISTIC = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { approvalTag, APPROVAL_MAX_AGE_SECONDS } from "../src/approval.ts";',
  'import { normalizeDashes } from "../src/normalize.ts";',
  'import type { Env } from "../src/env";',
  'import * as gh from "../src/github";',
  'import def, { a, b as c } from "../src/x";',
  'import "../src/side-effect.ts";',
  'import { z } from "zod";',
].join("\n");

test("PLANT: a builtin import before a relative one is not swallowed into the clause", () => {
  const names = [...importedNames(REALISTIC)].sort();
  assert.deepEqual(names, ["APPROVAL_MAX_AGE_SECONDS", "Env", "a", "approvalTag", "b", "def", "gh", "normalizeDashes"]);
  for (const junk of ["assert", "test", "from", "import"]) {
    assert.ok(!names.includes(junk), `${junk} is a keyword or a builtin binding, never a name this repo exports`);
  }
});

// The same shape without semicolons, so a matcher that stops a clause at `;` cannot
// pass.
const NO_SEMICOLONS = [
  'import assert from "node:assert/strict"',
  'import { test } from "node:test"',
  'import { foo } from "../src/foo"',
  'import def, { a, b as c } from "../src/x"',
  "const n = 1",
  'import * as gh from "../src/github"',
].join("\n");

test("PLANT: a file without semicolons reports its real names and no keyword", () => {
  assert.deepEqual([...importedNames(NO_SEMICOLONS)].sort(), ["a", "b", "def", "foo", "gh"]);
});

test("PLANT: re-exports, dynamic imports and require are read too", () => {
  // ../lib rather than ../src: any relative path counts, and test/scanner-rules.test.ts
  // reads a dynamic import of src/ in a test body as a source-text read.
  const text = [
    'export { reexported, other as renamed } from "../lib/re"',
    'export * from "../lib/star"',
    'const { dynA, dynB: local } = await import("../lib/dyn")',
    "const mod = await import('../lib/whole')",
    'const { required } = require("../lib/req")',
    'const member = (await import("../lib/m")).memberName',
    'const pkg = await import("zod")',
    'import "../lib/side-effect"',
  ].join("\n");
  assert.deepEqual([...importedNames(text)].sort(), ["dynA", "dynB", "memberName", "mod", "other", "reexported", "required"]);
});

test("an export that is not a re-export is not read as a clause", () => {
  // It must not swallow the lines up to the next relative specifier.
  const text = ["export const x = 1", "export default x", 'import { real } from "../src/r"'].join("\n");
  assert.deepEqual([...importedNames(text)], ["real"]);
});

test("only RELATIVE imports count, because a package says nothing about this repo", () => {
  assert.deepEqual([...importedNames('import { z } from "zod";')], []);
  assert.deepEqual([...importedNames('import { readFileSync } from "node:fs";')], []);
});

test("a renamed import reports the SOURCE name, which is the export that must survive", () => {
  // `b as c` binds c locally, but deleting `b` is what breaks the case.
  assert.deepEqual([...importedNames('import { b as c } from "../src/x";')], ["b"]);
});

test("a multi-line import clause is one statement", () => {
  const text = ['import {', "  alpha,", "  beta,", '} from "../src/x";'].join("\n");
  assert.deepEqual([...importedNames(text)].sort(), ["alpha", "beta"]);
});

// the manifest

test("the manifest is names only, and reads past comments and blank lines", () => {
  const text = ["# what this is", "", "alpha", "beta", "  gamma  ", ""].join("\n");
  assert.deepEqual(parseImportsManifest(text), ["alpha", "beta", "gamma"]);
});

test("the path convention has one spelling", () => {
  assert.equal(holdoutImportsPath("capsid"), "improve/holdout/capsid/imports.txt");
  assert.equal(holdoutImportsPath("foxing"), "improve/holdout/foxing/imports.txt");
});

// the refusal, which is what Job B acts on

const CASE = 'import { test } from "node:test";\nimport { alpha, beta } from "../src/x.ts";';

test("PLANT: an import the manifest does not list is refused, by name", () => {
  const refusal = holdoutImportRefusal([CASE], ["alpha"], "capsid");
  assert.ok(refusal);
  assert.match(refusal!, /does not list: beta/);
  assert.match(refusal!, /improve\/holdout\/capsid\/imports\.txt/);
});

test("PLANT: no manifest at all is refused, and hands over the list to create", () => {
  const refusal = holdoutImportRefusal([CASE], null, "capsid");
  assert.ok(refusal);
  assert.match(refusal!, /no improve\/holdout\/capsid\/imports\.txt/);
  // The refusal contains the file to write.
  assert.match(refusal!, /alpha\nbeta/);
});

test("a complete manifest passes, so the guard is not simply always red", () => {
  assert.equal(holdoutImportRefusal([CASE], ["alpha", "beta"], "capsid"), null);
  // A manifest listing more than the suite uses is fine: an extra name only makes
  // an export undeletable.
  assert.equal(holdoutImportRefusal([CASE], ["alpha", "beta", "gamma"], "capsid"), null);
});
