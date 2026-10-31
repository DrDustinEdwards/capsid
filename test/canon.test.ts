import assert from "node:assert/strict";
import { test } from "node:test";
import { isCanonPath } from "../src/canon.ts";

// Which documents are canon (src/canon.ts): the path rules are exact strings, and their
// near misses are not canon. Who may change one is tested against real D1 in
// test-integration/canon.test.ts.

test("canon paths match, and their near misses do not", () => {
  const canon: Array<[string, string]> = [
    ["capsid", "conventions.md"],
    ["capsid", "conventions-improve.md"],
    ["capsid", "core.md"],
    ["sample", "core.md"],
    ["capsid", "decisions.md"],
    ["capsid", "archive/decisions-vol-4.md"],
    ["sample", "archive/decisions.md"],
    ["sample", "decisions.md"],
  ];
  const not: Array<[string, string]> = [
    ["sample", "conventions.md"],
    ["sample", "repo-structure.md"],
    ["capsid", "repo-structure.md"],
    ["capsid", "research/core.md"],
    ["capsid", "core.md.bak"],
    ["capsid", "Core.md"],
    ["capsid", "./core.md"],
    ["capsid", "decisions-vol-5.md"],
    ["capsid", "decisions-vol-x.md"],
    ["capsid", "decisions-notes.md"],
    ["capsid", "archive/decisions.md.old"],
    ["capsid", "rulings/testing-2026-10-04.md"],
    ["capsid", "policy/gates.md"],
    ["capsid", "jobs/job_0123456789ab.md"],
  ];
  for (const [ns, path] of canon) assert.ok(isCanonPath(ns, path), `${ns}/${path} is not canon`);
  for (const [ns, path] of not) assert.ok(!isCanonPath(ns, path), `${ns}/${path} is canon`);
});
