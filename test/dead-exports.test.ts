import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { holdoutImportsPath, parseImportsManifest } from "../scripts/improve-report.mjs";
import { exportsOfSrc } from "./source-files.ts";

// The exports the hidden holdout suite imports. The holdout is invisible to anything
// that runs here, so an export with no visible caller may still be needed by it. Its
// import manifest, improve/holdout/<ns>/imports.txt, names what it needs, and these
// tests keep src/ exporting it. The dead-export report itself is a lint:
// test/lint/dead-exports.lint.ts, run by `npm run lint:dead-exports`.

const ROOT = join(import.meta.dirname, "..");

// The one namespace whose holdout this repo carries. Read through the shared
// helper so the path convention has a single spelling.
const MANIFEST = holdoutImportsPath("capsid");

function declaredByHoldout(): string[] {
  return parseImportsManifest(readFileSync(join(ROOT, MANIFEST), "utf8"));
}

test("PLANT: the holdout import manifest exists and names the exports it needs", () => {
  const declared = declaredByHoldout();
  assert.ok(declared.length > 0, `${MANIFEST} declares nothing; a manifest nobody fills is a guard nobody has`);
  // Every name it declares must be an export of src/.
  const names = new Set(exportsOfSrc().map((e) => e.name));
  assert.ok(names.size > 100, `only ${names.size} exports found across src/; the walk is broken`);
  const phantom = declared.filter((n) => !names.has(n));
  assert.deepEqual(phantom, [], `${MANIFEST} names exports that src/ does not have: ${phantom.join(", ")}`);
});

test("PLANT: the two exports the holdout imports are still exported from src", () => {
  // Named, not derived, so removing either fails here with the reason attached
  // rather than as a failed holdout anchor.
  const names = new Set(exportsOfSrc().map((e) => e.name));
  for (const name of ["seedScoresDoc", "hasWideDash"]) {
    assert.ok(
      names.has(name),
      `${name} is imported by the hidden holdout suite and must stay exported from src/. ` +
        `Removing it scored 28 of 30 against an anchor of min 1.0 on 2026-09-07.`
    );
    assert.ok(declaredByHoldout().includes(name), `${name} must be listed in ${MANIFEST}`);
  }
});
