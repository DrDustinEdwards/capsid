import { inTestDir, type PrFileRow } from "./github/pr-files";

// Narrow test protection on complete (docs/work-queue.md, "CI on complete"; Grok design
// review 2026-10-23, build step 5). Green CI shows nothing when the change took away the
// test that would have failed, so complete is refused when a pull request removes a test
// file, removes or renames a test, or adds a skip, unless the job's body names that file
// or test. Only these three: editing a test's body is ordinary work, and is left to the
// reviewer and to auto-merge, which never merges an existing test edit unattended.

// Test files in any of the repos: capsid's directories and merge-class's names, plus
// Python's and Go's own naming.
const isTestFile = (path: string | undefined) => inTestDir(path) || (path !== undefined && /(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(path));

// A test's declaration on one diff line: its name, or null.
const DECLARATIONS = [
  /\b(?:it|test|describe)(?:\.only|\.skip|\.todo|\.each\s*\([^)]*\))?\s*\(\s*(['"`])(.+?)\1/,
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/,
  /^\s*class\s+(Test\w*)\b/,
  /^\s*func\s+(Test\w*)\s*\(/,
];
function testName(line: string): string | null {
  for (const re of DECLARATIONS) {
    const m = re.exec(line);
    if (m) return m[m.length - 1];
  }
  return null;
}

const SKIP = /\b(?:it|test|describe)\.(?:skip|todo)\b|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\(|@unittest\.skip|\bself\.skipTest\(|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|@Disabled\b/;

/** What a pull request's files take away from its tests, each unless the job body names it. Pure. */
export function weakenedTests(rows: readonly PrFileRow[], jobBody: string): string[] {
  const named = (s: string) => jobBody.includes(s);
  const found: string[] = [];
  for (const f of rows) {
    const old = f.previous_filename ?? f.filename;
    if (isTestFile(old) && (f.status === "removed" || (f.previous_filename && !isTestFile(f.filename)))) {
      if (!named(old)) found.push(`removes the test file ${old}`);
      continue;
    }
    if (!isTestFile(f.filename) || f.status === "added") continue;
    if (f.patch === undefined) {
      if ((f.deletions ?? 1) > 0 && !named(f.filename)) found.push(`changes ${f.filename}, and GitHub gave no diff of it to read`);
      continue;
    }
    const lines = f.patch.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
    const removed = new Set<string>();
    const added = new Set<string>();
    for (const line of lines) {
      const name = testName(line.slice(1));
      if (name && line.startsWith("-")) removed.add(name);
      if (name && line.startsWith("+")) added.add(name);
    }
    lines.forEach((line, i) => {
      const text = line.slice(1);
      if (!line.startsWith("+") || !SKIP.test(text)) return;
      // The test the skip is on: its own line, or the declaration a decorator sits above.
      // A skip on a test this pull request adds is not one taken away; one whose test
      // cannot be found is counted, since it cannot be shown new.
      const own = testName(text);
      const below = own ? null : lines.slice(i + 1, i + 4).find((l) => !l.startsWith("-") && testName(l.slice(1)));
      const name = own ?? (below ? testName(below.slice(1)) : null);
      const isNew = name !== null && (own ? true : below!.startsWith("+")) && added.has(name) && !removed.has(name);
      if (!isNew && !named(name ?? f.filename)) found.push(`adds a skip in ${f.filename}: ${text.trim().slice(0, 80)}`);
    });
    for (const name of removed) {
      if (!added.has(name) && !named(name)) found.push(`removes or renames the test "${name}" in ${f.filename}`);
    }
  }
  return found;
}
