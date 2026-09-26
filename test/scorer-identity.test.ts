import assert from "node:assert/strict";
import { test } from "node:test";
import { SCORER_MARKER, digest, normalizePins, sharedBlock } from "../src/scorer-identity.ts";
import { identityFindings } from "../src/watcher.ts";
import { blockHash, normalizePins as scriptNormalizePins, splitBlock } from "../scripts/sync-scorer.mjs";

// The score job below the marker and scripts/improve-report.mjs are meant to be
// identical in all five roster repos. The watcher measures that, because it is the
// only component with read access to all five.
//
// Two implementations exist on purpose: the Worker cannot import the offline script
// and the script has no Worker bindings. The first test stops them drifting.

const SAMPLE = [
  "jobs:",
  "  build:",
  "    steps:",
  "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5",
  `  # ${SCORER_MARKER} ACROSS ALL FIVE ROSTER REPOS.`,
  "  score:",
  "    steps:",
  "      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5",
  "        run: npm ci",
  "",
].join("\n");

test("THE WORKER AND THE COPIER AGREE, byte for byte, on both halves", async () => {
  // Same split.
  const fromSrc = sharedBlock(SAMPLE);
  const fromScript = splitBlock(SAMPLE, "sample").tail;
  assert.ok(fromSrc, "the src splitter found no marker in a sample that has exactly one");
  assert.equal(fromSrc, fromScript, "the two splitters disagree about where the shared block starts");

  // Same pin normalization.
  assert.equal(normalizePins(SAMPLE), scriptNormalizePins(SAMPLE), "the two pin normalizers disagree");

  // Same hash, which is the value a finding prints and a human compares.
  assert.equal(await digest(fromSrc), blockHash(fromScript), "the Worker and the copier hash the same block differently");
});

test("a marker that is missing or doubled yields no block rather than a guess", () => {
  assert.equal(sharedBlock("jobs:\n  build:\n"), null, "a file with no marker produced a block");
  assert.equal(sharedBlock(`${SAMPLE}\n# ${SCORER_MARKER} again\n`), null, "a doubled marker produced a block");
});

test("line endings do not change the hash", async () => {
  assert.equal(await digest(SAMPLE.replace(/\n/g, "\r\n")), await digest(SAMPLE));
});

// What the finding says.

const surface = (namespace: string, block: string, report: string) => ({ namespace, block, report });

test("five repos that agree produce NO finding", () => {
  const read = ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"].map((n) => surface(n, "aaaa", "bbbb"));
  assert.deepEqual(identityFindings(read, [], []), []);
});

test("A DIVERGENCE NAMES WHICH REPOS AND WHICH BLOCK", () => {
  const read = [
    surface("capsid", "aaaa", "bbbb"),
    surface("dustinedwards", "cccc", "bbbb"),
    surface("foxhound", "cccc", "bbbb"),
    surface("foxing", "cccc", "dddd"),
    surface("germomics", "cccc", "bbbb"),
  ];
  const [f] = identityFindings(read, [], []);
  assert.ok(f, "a roster with two score blocks produced no finding");
  assert.match(f.title, /2 score block\(s\), 2 report script\(s\)/);
  assert.match(f.body, /aaaa: capsid/, "the finding does not name the odd repo out");
  assert.match(f.body, /cccc: dustinedwards, foxhound, foxing, germomics/, "the finding does not group the agreeing repos");
  assert.match(f.body, /dddd: foxing/, "the finding does not name the diverging report script");
  assert.match(f.body, /5 of 5 repos read/, "the finding does not say how many repos it read");
});

test("A READ THAT RETURNED NOTHING IS A FINDING, never silent agreement", () => {
  // Four repos unreadable and the fifth matching itself must not read as clean.
  const findings = identityFindings([surface("capsid", "aaaa", "bbbb")], ["foxhound", "foxing", "germomics"], ["dustinedwards"]);
  assert.ok(findings.length >= 1, "an unreadable roster reported nothing at all");
  const unread = findings.find((f) => /could not be read everywhere/.test(f.title));
  assert.ok(unread, "no finding for the repos that could not be read");
  for (const name of ["foxhound", "foxing", "germomics", "dustinedwards"]) {
    assert.match(unread.body, new RegExp(name), `${name} was dropped from the comparison without being named`);
  }
  assert.match(unread.body, /1 of 5 repos read/, "the finding does not say how few repos it read");
});

test("one readable repo is never reported as agreement", () => {
  const findings = identityFindings([surface("capsid", "aaaa", "bbbb")], [], []);
  assert.ok(
    findings.some((f) => /cannot be compared/.test(f.title)),
    "a single repo matched itself and was treated as identity"
  );
});

test("zero readable repos reports the unread, and claims nothing about identity", () => {
  const findings = identityFindings([], ["capsid", "dustinedwards", "foxhound", "foxing", "germomics"], []);
  assert.equal(findings.length, 1, "an entirely unreadable roster produced more than the unread finding");
  assert.match(findings[0].body, /0 of 5 repos read/);
});

test("A REPORT SCRIPT THAT DIVERGES ALONE IS REPORTED, even when every block agrees", () => {
  // A comparison of `blocks.size > 1` alone would miss a change to only
  // scripts/improve-report.mjs.
  const read = [
    surface("capsid", "aaaa", "bbbb"),
    surface("dustinedwards", "aaaa", "cccc"),
    surface("foxhound", "aaaa", "cccc"),
    surface("foxing", "aaaa", "cccc"),
    surface("germomics", "aaaa", "cccc"),
  ];
  const [f] = identityFindings(read, [], []);
  assert.ok(f, "a roster agreeing on every score block but split on the report script reported nothing");
  assert.match(f.title, /1 score block\(s\), 2 report script\(s\)/);
  assert.match(f.body, /bbbb: capsid/, "the finding does not name the odd report script out");
});
