import assert from "node:assert/strict";
import { test } from "node:test";
import { overlapLine, overlapsOf, prUrlsIn } from "../src/job-overlaps.ts";

// Overlap warnings (Track A D1): the intersection and the line the seat reads. The reads
// from GitHub are in test-integration/job-overlaps.test.ts.

test("a file changed by the named pull request and by another open one is an overlap, oldest first", () => {
  const found = overlapsOf(
    [{ number: 134, paths: ["src/jobs.ts", "docs/a.md"] }],
    [
      { number: 130, paths: ["src/jobs.ts", "src/x.ts"] },
      { number: 128, paths: ["src/jobs.ts"] },
      { number: 140, paths: ["src/other.ts"] },
    ]
  );
  assert.deepEqual(found, [
    { pr: 134, other: 128, files: ["src/jobs.ts"] },
    { pr: 134, other: 130, files: ["src/jobs.ts"] },
  ]);
});

test("no shared file is no overlap, and an empty read is no overlap rather than an error", () => {
  assert.deepEqual(overlapsOf([{ number: 1, paths: ["a"] }], [{ number: 2, paths: ["b"] }]), []);
  assert.deepEqual(overlapsOf([{ number: 1, paths: [] }], [{ number: 2, paths: [] }]), []);
});

test("a rename listed under both names collides with a pull request that edits either name", () => {
  // readPrFiles lists a renamed file under its old and new path.
  const renamed = { number: 7, paths: ["src/old.ts", "src/new.ts"] };
  assert.equal(overlapsOf([renamed], [{ number: 3, paths: ["src/old.ts"] }]).length, 1);
  assert.equal(overlapsOf([renamed], [{ number: 4, paths: ["src/new.ts"] }]).length, 1);
});

test("a job's own pull requests are not compared with each other, nor with themselves", () => {
  const found = overlapsOf(
    [{ number: 10, paths: ["a"] }, { number: 11, paths: ["a"] }],
    [{ number: 10, paths: ["a"] }, { number: 11, paths: ["a"] }]
  );
  assert.deepEqual(found, []);
});

test("the line names each pair, caps the files shown and says how many more", () => {
  const line = overlapLine({ overlaps: [{ pr: 265, other: 260, files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }], problem: null });
  assert.equal(line, "Overlaps: #265 with #260 (a.ts, b.ts, c.ts, +2 more). Merge in PR order, oldest first, and rebase the later.");
});

test("a comparison that could not be read says not checked, and a clean one says nothing", () => {
  assert.equal(overlapLine({ overlaps: [], problem: "#4 files: page 1 returned 502" }), "Overlaps: not checked (#4 files: page 1 returned 502).");
  assert.equal(overlapLine({ overlaps: [], problem: null }), null);
  const partial = overlapLine({ overlaps: [{ pr: 2, other: 1, files: ["a"] }], problem: "3 open pull requests were not read" });
  assert.match(partial ?? "", /^Overlaps: #2 with #1 \(a\)\./);
  assert.match(partial ?? "", /Not fully checked \(3 open pull requests were not read\)\.$/);
});

test("pull request URLs are found in a command, once each", () => {
  const command = "gh pr merge https://github.com/example/sample/pull/9 --squash; gh pr view https://github.com/example/sample/pull/9";
  assert.deepEqual(prUrlsIn(command), ["https://github.com/example/sample/pull/9"]);
  assert.deepEqual(prUrlsIn("git -C wt push -u origin feat/x"), []);
  assert.deepEqual(prUrlsIn(undefined), []);
});
