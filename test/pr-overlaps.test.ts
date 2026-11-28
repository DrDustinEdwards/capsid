import assert from "node:assert/strict";
import { test } from "node:test";
import { overlapsOf } from "../src/pr-overlaps.ts";

test("a file changed by the named pull request and by another open one is an overlap, oldest first", () => {
  const found = overlapsOf(
    [{ number: 134, paths: ["src/a.ts", "docs/a.md"] }],
    [
      { number: 130, paths: ["src/a.ts", "src/x.ts"] },
      { number: 128, paths: ["src/a.ts"] },
      { number: 140, paths: ["src/other.ts"] },
    ],
  );
  assert.deepEqual(found, [
    { pr: 134, other: 128, files: ["src/a.ts"] },
    { pr: 134, other: 130, files: ["src/a.ts"] },
  ]);
});

test("no shared file, an empty read, the named pull requests and a rename listed under both names", () => {
  assert.deepEqual(overlapsOf([{ number: 1, paths: ["a"] }], [{ number: 2, paths: ["b"] }]), []);
  assert.deepEqual(overlapsOf([{ number: 1, paths: [] }], [{ number: 2, paths: [] }]), []);

  const own = [
    { number: 10, paths: ["a"] },
    { number: 11, paths: ["a"] },
  ];
  assert.deepEqual(overlapsOf(own, own), []);

  // readPrFiles lists a renamed file under its old and new path.
  const renamed = { number: 7, paths: ["src/old.ts", "src/new.ts"] };
  assert.equal(overlapsOf([renamed], [{ number: 3, paths: ["src/old.ts"] }]).length, 1);
  assert.equal(overlapsOf([renamed], [{ number: 4, paths: ["src/new.ts"] }]).length, 1);
});
