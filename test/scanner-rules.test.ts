import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unmarkedScanners } from "./scanner-rules.ts";

// EVERY TEST THAT READS src/ AS TEXT NAMES THE RULE IT ENFORCES (job_3e1596235513).
//
// A source-text test breaks on a rename and can pass while the behaviour is gone, so
// the suite converted every one it could into a test that calls the code. The ones
// that remain are there because no call can show what they check: a comment, a site
// that does not exist yet, or a module node cannot load. Each carries a
// `// scanner-rule: <rule>` line directly above it. A new source-text test without
// one fails here, which is the moment to ask whether a behaviour test would do.

const DIR = import.meta.dirname;

// THIS FILE IS NOT SCANNED. Its fixtures below spell the very patterns it looks for.
const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".test.ts") && name !== "scanner-rules.test.ts")
  .sort();

test("every test that reads src/ as text carries a scanner-rule line", () => {
  let scanned = 0;
  let scanners = 0;
  const unmarked: string[] = [];
  for (const name of files) {
    const result = unmarkedScanners(readFileSync(join(DIR, name), "utf8"));
    scanned += 1;
    scanners += result.scanners;
    unmarked.push(...result.unmarked.map((line) => `test/${name}: ${line}`));
  }
  // Floors, so a walk or a detector that finds nothing fails instead of passing.
  assert.ok(scanned > 100, `only ${scanned} test files were read`);
  assert.ok(scanners > 70, `only ${scanners} source-text tests were found; the detector is broken`);
  assert.deepEqual(
    unmarked,
    [],
    `these tests read src/ as text and name no rule. Replace each with a test that calls the code, or add a "// scanner-rule: <rule>" line above it.`
  );
});

// ---- the detector, on fixtures ----------------------------------------------------

const lines = (...parts: string[]) => parts.join("\n") + "\n";

test("a direct read is a scanner, and a marker above it satisfies the rule", () => {
  const bare = lines('test("x", () => {', '  assert.match(sourceFile("a.ts"), /y/);', "});");
  assert.deepEqual(unmarkedScanners(bare), { scanners: 1, unmarked: ['test("x", () => {'] });
  const marked = lines("// scanner-rule: CLAUDE.md rule 6", bare);
  assert.deepEqual(unmarkedScanners(marked), { scanners: 1, unmarked: [] });
});

test("a marker inside the test body does not count", () => {
  const inside = lines('test("x", () => {', "  // scanner-rule: somewhere else", '  assert.ok(sourceFiles().length);', "});");
  assert.equal(unmarkedScanners(inside).unmarked.length, 1);
});

test("a read through a module-level constant or function is found, however deep", () => {
  const viaConst = lines('const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "a.ts"), "utf8");', 'test("x", () => {', "  assert.match(SOURCE, /y/);", "});");
  assert.equal(unmarkedScanners(viaConst).unmarked.length, 1);
  const viaChain = lines(
    "function blocks() {",
    "  return toolBlocks();",
    "}",
    "const NAMES = blocks().map((b) => b.name);",
    'test("x", () => {',
    "  assert.ok(NAMES.length);",
    "});"
  );
  assert.equal(unmarkedScanners(viaChain).unmarked.length, 1);
  const viaHelper = lines('const read = (p: string) => readFileSync(p, "utf8");', 'test("x", () => {', '  read("../src/routes.ts");', "});");
  assert.equal(unmarkedScanners(viaHelper).unmarked.length, 1);
});

test("THE INNOCENT DIRECTION: calling code from src/ is not reading it", () => {
  const fixture = lines(
    'import { thing } from "../src/thing.ts";',
    "// sourceFile() is only named in this comment",
    'const QUOTED = \'import { a } from "../src/a.ts";\';',
    'test("calls", async () => {',
    '  const { other } = await import("../src/other.ts");',
    "  assert.ok(thing(other, QUOTED));",
    "});"
  );
  assert.deepEqual(unmarkedScanners(fixture), { scanners: 0, unmarked: [] });
});

test("a test generated in a loop is found too", () => {
  const loop = lines("for (const f of FILES) {", '  test(f, () => assert.ok(allSourceText().includes(f)));', "}");
  assert.equal(unmarkedScanners(loop).unmarked.length, 1);
});
