import assert from "node:assert/strict";
import { test } from "node:test";
import { knipCounts } from "../scripts/no-bloat-report.mjs";

// The no-bloat report (scripts/no-bloat-report.mjs) reads Knip's compact report by its
// headings. A heading it cannot read would report nothing and warn about nothing.

test("PLANT: each Knip heading is read with its count, and nothing else is", () => {
  const text = ["Unused files (2)", "src/a.ts: src/a.ts", "Unused exports (12)", "src/b.ts: x, y", "Unlisted dependencies (1)", "src/c.ts: lodash", "not a heading (3) here"].join("\n");
  assert.deepEqual(knipCounts(text), { "Unused files": 2, "Unused exports": 12, "Unlisted dependencies": 1 });
});

test("a clean report has no headings, so no counts", () => {
  assert.deepEqual(knipCounts("✂️  Excellent, Knip found no issues.\n"), {});
});
