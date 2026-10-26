import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { exportsOfSrc, sourceFiles } from "../source-files.ts";

// The dead-export lint. Run by `npm run lint:dead-exports` (and `npm run lint`), in
// the checks job of .github/workflows/ci.yml; not part of `npm test`. It fails when
// an export has no caller, which is a review prompt about the code as a whole rather
// than a behavior of the Worker, so it runs beside the suite instead of inside it.
//
// An export is dead only when it has no caller in src/, test/, test-integration/ or
// scripts/.

const ROOT = join(import.meta.dirname, "..", "..");

// This file is not a caller. It lists every suspect by name below, so counting
// itself would make each one look used and the set would collapse to empty.
const SELF = "test/lint/dead-exports.lint.ts";

// Everything that could be a caller: the rest of src/, both test suites, the lints,
// and scripts/.
function otherReaders(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const dir of ["test", "test/lint", "test-integration", "scripts"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!/\.(ts|mts|mjs)$/.test(file)) continue;
      if (`${dir}/${file}` === SELF) continue;
      out.push({ name: `${dir}/${file}`, text: readFileSync(join(ROOT, dir, file), "utf8") });
    }
  }
  return out;
}

const READERS = otherReaders();


// A barrel re-export is not a caller. `export { x } from "./y"` names x to forward
// it, not to use it, so counting it would make every symbol behind a barrel look
// called. A plain `import { x } from` is left alone, because importing a name to
// use it is what a caller does.
//
// A comment is not a caller either. `hasCallerElsewhere` looks for the bare name,
// so one comment naming a function elsewhere would make it look called.
//
// String literals are kept. A name inside a string can be a real reference (a
// registry keyed by name, a dynamic import), and a false positive here is only a
// red build asking for a reviewed name.
//
// Scanned character by character rather than by regex, because a regex that cuts
// from `//` to end of line also cuts the middle out of "https://example.com" and
// would hide a real caller sitting after a URL on the same line.
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const RE_EXPORT_FROM = /export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g;
const RE_EXPORT_STAR = /export\s+\*(?:\s+as\s+[A-Za-z0-9_]+)?\s+from\s*["'][^"']+["'];?/g;
// What a caller can look like, once prose and forwarding are removed.
function callableText(text: string): string {
  return stripComments(text).replace(RE_EXPORT_FROM, "").replace(RE_EXPORT_STAR, "");
}

// Every identifier in a file's callable text, computed once per file. An export name
// is word characters only, so `\bname\b` matches exactly when some maximal run of
// word characters equals the name, which is a set lookup and much cheaper than a
// regex per reader per export.
function identifiers(text: string): Set<string> {
  return new Set(callableText(text).match(/\w+/g) ?? []);
}

let callerIndex: { src: Array<{ name: string; ids: Set<string> }>; readers: Array<Set<string>> } | null = null;
function callers() {
  callerIndex ??= {
    src: sourceFiles().map((f) => ({ name: f.name, ids: identifiers(f.text) })),
    readers: READERS.map((f) => identifiers(f.text)),
  };
  return callerIndex;
}

function hasCallerElsewhere(name: string, ownFile: string): boolean {
  const index = callers();
  if (index.src.some((f) => f.name !== ownFile && f.ids.has(name))) return true;
  return index.readers.some((ids) => ids.has(name));
}

// scanner-rule: capsid/conventions-verification.md 2026-09-08, an export is dead only with no caller in src/, test/ or scripts/ (count guard)
test("the scan finds the exports at all, so nothing here can pass by reading nothing", () => {
  const exported = exportsOfSrc();
  assert.ok(exported.length > 100, `only ${exported.length} exports found across src/; the walk is broken`);
  assert.ok(sourceFiles().length > 20, "src/ walk returned too few files");
});

// The suspects: exports with no caller in src/, test/, test-integration/ or
// scripts/. Each is a candidate for removal that someone looked at and kept.
//
// Listed rather than counted, so a new suspect fails the build the day it appears
// and removing one means editing this list.
// Keyed by export name, not by file, so a module move does not change the set.
const KNOWN_SUSPECTS = [
  "aggregate",
  "HEALTH_PROBE_NS",
  "HEALTH_PROBE_PATH",
];

// Two checks, and neither is "the set still matches exactly": splitting a module
// turns intra-file usage into cross-file usage, so a suspect can gain a caller
// without a line of its own changing, and that is not a defect.
//
//   (a) A reviewed name must still be exported, or the list is stale.
//   (b) No new no-caller export may appear unreviewed.
// scanner-rule: capsid/conventions-verification.md 2026-09-08, an export is dead only with no caller in src/, test/ or scripts/
test("every reviewed suspect is still exported from src/", () => {
  const names = new Set(exportsOfSrc().map((e) => e.name));
  const gone = KNOWN_SUSPECTS.filter((n) => !names.has(n));
  assert.deepEqual(
    gone,
    [],
    `these reviewed exports are no longer exported from src/: ${gone.join(", ")}.
` +
      `Take each off KNOWN_SUSPECTS.`
  );
});

// scanner-rule: capsid/conventions-verification.md 2026-09-08, an export is dead only with no caller in src/, test/ or scripts/
test("no new no-caller export appears without review", () => {
  const reviewed = new Set(KNOWN_SUSPECTS);
  const unreviewed: string[] = [];
  // The count, asserted before the result: an empty `unreviewed` is only
  // meaningful if this walked real exports across real readers.
  const examined = exportsOfSrc();
  assert.ok(examined.length > 100, `only ${examined.length} exports examined; the walk is broken`);
  assert.ok(READERS.length > 20, `only ${READERS.length} reader files loaded; the caller scan is broken`);
  for (const { file, name } of examined) {
    if (hasCallerElsewhere(name, file)) continue;
    if (reviewed.has(name)) continue;
    unreviewed.push(`${name} (src/${file})`);
  }
  assert.deepEqual(
    unreviewed.sort(),
    [],
    `these exports have no caller in src/, none in test/, test-integration/ or scripts/, ` +
      `and are not in the reviewed list: ${unreviewed.join(", ")}. ` +
      `Add them to KNOWN_SUSPECTS after looking, or give them a caller. ` +
      `(${examined.length} exports examined against ${READERS.length} reader files; comments and barrel re-exports do not count as callers.)`
  );
});
// The stripper itself. stripComments decides what counts as a caller, so a bug in
// it either hides a dead export (too little stripped) or hides a live caller (too
// much stripped).
test("a comment does not vouch for an export, and a URL in a string is not a comment", () => {
  assert.equal(stripComments("const a = 1; // mentions ghostName").includes("ghostName"), false);
  assert.equal(stripComments("/* ghostName */ const a = 1;").includes("ghostName"), false);
  assert.equal(stripComments("/**\n * ghostName\n */\nconst a = 1;").includes("ghostName"), false);

  // The case a regex stripper gets wrong: cutting from the first // to end of line
  // hides a caller sitting after a URL on the same line.
  const url = 'const u = "https://example.com/x"; realCaller(u);';
  assert.equal(stripComments(url), url, "a // inside a string was treated as a comment");
  assert.ok(stripComments(url).includes("realCaller"), "a real caller after a URL was stripped");

  // An escaped quote must not end the string early and expose the rest as code.
  const esc = 'const s = "a \\" // not a comment"; realCaller();';
  assert.ok(stripComments(esc).includes("realCaller"), "an escaped quote broke the string scan");

  // A name inside a string is deliberately KEPT: it can be a real reference.
  assert.ok(stripComments('const s = "ghostName";').includes("ghostName"));
});
