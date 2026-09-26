import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";

// document_links stores (namespace, path) strings, not documents.id, and the
// table carries no foreign key, so the database will not keep edges in step with
// a renamed or removed document. Application code is the only thing that can, so
// delete, move and lint finalize all route through pathMutation().
//
// These tests are a source guard rather than a behavioural one: they fail when a
// new mutation site appears, which a behavioural test over the known callers would
// not catch.

// The guard scans every file under src/, because a path mutation can be written in
// any module.
const SOURCES = sourceFiles();

const HELPER_START = "// PATH_MUTATION_HELPER_START";
const HELPER_END = "// PATH_MUTATION_HELPER_END";

function helperOwner(): { name: string; text: string } {
  const found = SOURCES.find((f) => f.text.includes(HELPER_START) && f.text.includes(HELPER_END));
  assert.ok(found, `${HELPER_START} / ${HELPER_END} markers are missing from src/`);
  return found;
}

function helperRange(): { file: string; text: string; start: number; end: number } {
  const owner = helperOwner();
  const start = owner.text.indexOf(HELPER_START);
  const end = owner.text.indexOf(HELPER_END);
  assert.ok(end > start, "helper end marker precedes its start marker");
  return { file: owner.name, text: owner.text, start, end };
}

// Every SQL fragment that renames a document or removes a documents row.
// Deliberately broad: it matches the shapes a future author is likely to write, not
// just the ones that exist today.
//
// The UPDATE pattern does not require path to be the first assignment in the SET
// clause, so `UPDATE documents SET updated_at = datetime('now'), path = ?3` is caught.
//
// It matches the SET clause only, stopping at WHERE, because `path` appears in the
// WHERE clause of almost every statement, and
// `UPDATE documents SET status = ?1 WHERE namespace = ?2 AND path = ?3` mutates no path.
const SET_CLAUSE = /UPDATE\s+documents\b([\s\S]{0,400}?)(?:\bWHERE\b|`|;)/gi;

function pathMutationHits(text: string): number[] {
  const hits: number[] = [];
  SET_CLAUSE.lastIndex = 0;
  for (let m = SET_CLAUSE.exec(text); m !== null; m = SET_CLAUSE.exec(text)) {
    if (/\bpath\s*=/i.test(m[1])) hits.push(m.index);
  }
  return hits;
}

function deleteHits(text: string): number[] {
  const hits: number[] = [];
  const re = /DELETE\s+FROM\s+documents\b/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) hits.push(m.index);
  return hits;
}

const MUTATION_PATTERNS: Array<{ label: string; find: (text: string) => number[] }> = [
  { label: "UPDATE documents SET ... path =", find: pathMutationHits },
  { label: "DELETE FROM documents", find: deleteHits },
];

// scanner-rule: CLAUDE.md, path mutation rule: a path mutation goes through pathMutation() and nowhere else (count guard)
test("the scan reads a plausible number of source files", () => {
  // If the directory walk broke, every offender check below would pass over an empty list.
  assert.ok(SOURCES.length >= 10, `expected to scan the src/ modules, found ${SOURCES.length}`);
  assert.ok(SOURCES.some((f) => f.text.includes(HELPER_START)));
});

// scanner-rule: CLAUDE.md, path mutation rule: a path mutation goes through pathMutation() and nowhere else
test("every documents.path mutation in src/ lives inside pathMutation()", () => {
  const { file, start, end } = helperRange();
  const offenders: string[] = [];

  for (const { name, text } of SOURCES) {
    for (const { label, find } of MUTATION_PATTERNS) {
      for (const index of find(text)) {
        const inHelper = name === file && index > start && index < end;
        if (!inHelper) {
          const line = text.slice(0, index).split("\n").length;
          offenders.push(`${label} at src/${name}:${line}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `documents.path is mutated outside pathMutation(). Route it through the helper so document_links moves with it:\n  ${offenders.join("\n  ")}`
  );
});

// scanner-rule: CLAUDE.md, path mutation rule: a path mutation goes through pathMutation() and nowhere else (the scan is not vacuous)
test("the helper actually contains both mutation shapes", () => {
  const { text, start, end } = helperRange();
  const body = text.slice(start, end);
  // If the helper stopped containing these, the test above would pass vacuously.
  for (const { label, find } of MUTATION_PATTERNS) {
    assert.ok(find(body).length > 0, `pathMutation() no longer contains: ${label}`);
  }
});

test("the widened UPDATE pattern catches a later path assignment", () => {
  // A path assignment after another SET column, checked against the matcher directly.
  const later = 'db.prepare("UPDATE documents SET updated_at = datetime(\'now\'), path = ?3 WHERE namespace = ?1")';
  assert.equal(pathMutationHits(later).length, 1, "a path assignment after another SET column is not being caught");
  const pathFirst = 'db.prepare("UPDATE documents SET path = ?3 WHERE namespace = ?1")';
  assert.equal(pathMutationHits(pathFirst).length, 1);
});

test("the UPDATE pattern does not fire on path in a WHERE clause", () => {
  // `path` is in the WHERE clause of nearly every statement in server.ts.
  const innocent = 'db.prepare("UPDATE documents SET status = ?1 WHERE namespace = ?2 AND path = ?3")';
  assert.deepEqual(pathMutationHits(innocent), []);
});
