import assert from "node:assert/strict";
import { test } from "node:test";
import { pathClassOf } from "../src/merge-class.ts";

test("each file's path class", () => {
  const cases: Array<[string, string]> = [
    ["docs/schema.md", "docs"],
    ["dashboard/src/styles.css", "dashboard-css"],
    ["dashboard/src/views/Agents.tsx", "dashboard-code"],
    ["test/inbox.test.ts", "tests"],
    ["package-lock.json", "deps-other"],
    ["src/inbox.ts", "src-routine"],
    ["src/store-guards.ts", "src-worth"],
    ["src/protected-paths.ts", "src-worth"],
    [".github/workflows/ci.yml", "workflow"],
    ["migrations/0036_shared_packages.sql", "migration"],
    ["src/billing/invoice.ts", "money"],
  ];
  for (const [path, expected] of cases) assert.equal(pathClassOf(path), expected, path);
});
