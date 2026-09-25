import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSourceFiles } from "./source-files.ts";

// The source walk is recursive, so a tool moved into a src/ subdirectory cannot
// hide from the guards that read through it. This proves the recursion against a
// fixture tree, so it does not depend on src/ actually being nested.

test("the source walk descends into subdirectories", () => {
  const root = mkdtempSync(join(tmpdir(), "srcwalk-"));
  try {
    writeFileSync(join(root, "top.ts"), "export const a = 1;");
    writeFileSync(join(root, "notes.md"), "ignored");
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools", "nested.ts"), "export const b = 2;");
    mkdirSync(join(root, "tools", "deep"));
    writeFileSync(join(root, "tools", "deep", "deeper.ts"), "export const c = 3;");

    const found = collectSourceFiles(root);
    const names = found.map((f) => f.name);
    // A top-level file keeps its basename; nested files are addressable by path.
    assert.deepEqual(names, ["tools/deep/deeper.ts", "tools/nested.ts", "top.ts"]);
    // Non-.ts files are not collected.
    assert.ok(!names.includes("notes.md"));
    // The text comes back with the file, so a nested guard target is scannable.
    assert.equal(found.find((f) => f.name === "tools/nested.ts")?.text, "export const b = 2;");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
