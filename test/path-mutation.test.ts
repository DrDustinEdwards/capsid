import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";

// document_links stores path strings with no foreign key, so only application code keeps edges in step with a renamed or
// removed document: delete, move and lint finalize route through pathMutation(). A source guard over all of src/, because
// it fails when a new mutation site appears, which a test over the known callers would not catch.
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

// Deliberately broad (shapes a future author is likely to write). The UPDATE pattern reads the SET clause only, stopping at
// WHERE, because `path` is in nearly every WHERE and `UPDATE documents SET status = ?1 WHERE ... AND path = ?3` mutates no path.
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

test("every documents.path mutation in src/ lives inside pathMutation()", () => {
  const { file, text: owner, start, end } = helperRange();
  // A helper that lost either shape would let the scan pass by matching nothing.
  for (const { label, find } of MUTATION_PATTERNS)
    assert.ok(
      find(owner.slice(start, end)).length > 0,
      `pathMutation() no longer contains: ${label}`,
    );
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
    `documents.path is mutated outside pathMutation(). Route it through the helper so document_links moves with it:\n  ${offenders.join("\n  ")}`,
  );
});
