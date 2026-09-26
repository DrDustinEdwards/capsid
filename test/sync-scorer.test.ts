import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MARKER, SOURCE_ROOT, blockHash, normalize, normalizePins, preservePinComments, splitBlock } from "../scripts/sync-scorer.mjs";

// The copier's mechanics, on this repo's copy only.
//
// The other roster repos are not on disk in CI, so this file cannot compare their
// copies. The cross-repo claim lives in the Worker's watcher, which can read all of
// them, and in test/scorer-identity.test.ts, which pins what that watcher reports.
//
// What is checked here is the split scripts/sync-scorer.mjs performs, and that its
// source resolves. Every copy the sync writes is decided by that split: a marker
// that moved, appeared twice, or vanished would send the wrong bytes to repos that
// deploy on merge.

const WORKFLOW_PATH = join(import.meta.dirname, "..", ".github", "workflows", "improve-score.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

test("the marker occurs exactly once in this repo's own score workflow", () => {
  const hits = normalize(workflow)
    .split("\n")
    .filter((line) => line.includes(MARKER));
  assert.equal(hits.length, 1, `expected one ${MARKER} line, found ${hits.length}`);
});

test("the split is lossless: head and tail reassemble the file byte for byte", () => {
  const { head, tail } = splitBlock(workflow, "improve-score.yml");
  assert.equal(`${head}\n${tail}`, normalize(workflow));
});

// A count check beside the content check, so "the block looks fine" cannot pass by
// reading nothing.
test("the tail is the shared block: it starts at the marker and carries the score job", () => {
  const { tail } = splitBlock(workflow, "improve-score.yml");
  const lines = tail.split("\n");
  assert.ok(lines[0].includes(MARKER), "the tail must begin with the marker line");
  assert.ok(lines.length > 100, `the shared block should be substantial, got ${lines.length} lines`);
  assert.ok(/^\s{2}score:$/m.test(tail), "the score job must live inside the shared block");
  assert.ok(!/^\s{2}build:$/m.test(tail), "the per-repo build job must stay above the marker");
});

test("blockHash is stable and independent of line endings", () => {
  const { tail } = splitBlock(workflow, "improve-score.yml");
  assert.equal(blockHash(tail), blockHash(tail));
  assert.equal(blockHash(tail), blockHash(tail.replace(/\n/g, "\r\n")));
  assert.match(blockHash(tail), /^[0-9a-f]{64}$/);
});

test("splitBlock refuses a missing marker", () => {
  assert.throws(() => splitBlock("jobs:\n  build:\n    runs-on: ubuntu-latest\n", "no-marker.yml"), /marker found 0 times/);
});

test("splitBlock refuses a duplicate marker, rather than guessing a split point", () => {
  const doubled = `# ${MARKER}\nscore:\n# ${MARKER}\n`;
  assert.throws(() => splitBlock(doubled, "doubled.yml"), /marker found 2 times/);
});

// the copier's own configuration

test("the copier's source resolves to THIS repository, whatever it is named", () => {
  // Derived from the script's own location, so a rename of the repository cannot
  // point it at a directory that does not exist. Checked by looking for the two
  // files the copier reads.
  assert.ok(existsSync(SOURCE_ROOT), `the copier's source does not exist: ${SOURCE_ROOT}`);
  assert.ok(existsSync(join(SOURCE_ROOT, "package.json")), `${SOURCE_ROOT} is not a repository root`);
  assert.ok(
    existsSync(join(SOURCE_ROOT, ".github", "workflows", "improve-score.yml")),
    "the copier's source has no scorer workflow to copy"
  );
  assert.ok(existsSync(join(SOURCE_ROOT, "scripts", "improve-report.mjs")), "the copier's source has no report script to copy");
});

// The pin is shared; the version comment is not.
//
// Renovate can expand "# v5" to "# v5.1.0" in one repo with the SHA unchanged. The
// SHA is the security property and stays strict; the comment is normalized for
// comparison and preserved on write, so re-syncing does not revert Renovate's edit
// every cycle.

const PINNED = "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5";
const PINNED_LONG = "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0";
const PINNED_OTHER_SHA = "      - uses: actions/checkout@0000000000000000000000000000000000000000 # v5";

test("the version comment is normalized away and the SHA is not", () => {
  assert.equal(normalizePins(PINNED), normalizePins(PINNED_LONG), "two spellings of the same pin did not compare equal");
  assert.ok(normalizePins(PINNED).includes("fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09"), "normalizing dropped the SHA");
  assert.notEqual(
    normalizePins(PINNED),
    normalizePins(PINNED_OTHER_SHA),
    "A DIFFERENT SHA MUST STILL BE A DIFFERENCE. That is the guard firing, and it means one repo is running an action version nobody reviewed."
  );
});

test("a line that is not a pinned action is untouched", () => {
  const plain = "        run: npm ci # install";
  assert.equal(normalizePins(plain), plain);
  const tagged = "      - uses: ./local-action # not pinned by sha";
  assert.equal(normalizePins(tagged), tagged);
});

test("writing PRESERVES the target's own comment when the SHA is unchanged", () => {
  const written = preservePinComments(PINNED, PINNED_LONG);
  assert.equal(written, PINNED_LONG, "the copier would have reverted Renovate's annotation");
});

test("writing keeps the source comment when the target has no such pin", () => {
  const written = preservePinComments(PINNED, "      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");
  assert.equal(written, PINNED, "a pin new to the target lost its comment");
});

test("writing does not carry a comment across a SHA change", () => {
  // The target's comment describes the version the target had. If the SHA moved,
  // that comment is now wrong and the source's is the accurate one.
  const written = preservePinComments(PINNED_OTHER_SHA, PINNED_LONG);
  assert.equal(written, PINNED_OTHER_SHA, "a stale version comment was carried onto a new SHA");
});
