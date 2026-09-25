import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { holdoutImportsPath, parseImportsManifest } from "../scripts/improve-report.mjs";
import { exportsOfSrc } from "./source-files.ts";

// THE EXPORTS THE HIDDEN HOLDOUT SUITE IMPORTS.
//
// On 2026-09-07 a bloat pass removed `seedScoresDoc` and `hasWideDash` from src/
// as exports with no caller in src/ or test/. The hidden holdout suite imports
// both, and the holdout is structurally invisible to anything that runs here:
// that is its entire point. Master then scored 28 of 30 against an anchor of
// `holdout_pass_rate: min 1.0`, which would have reverted every attempt this
// repo ever made. Scoring a branch with both restored gave 30 of 30.
//
// So the holdout's import manifest, improve/holdout/<ns>/imports.txt, names what
// it needs, and these two tests keep src/ exporting it. They protect a real
// consumer, so they stay in `npm test`. The dead-export report itself (which
// exports have no caller anywhere, against a reviewed list) is a lint:
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
  // Every name it declares must actually BE an export of src/. A manifest naming
  // something that does not exist is a manifest describing a repo that moved on.
  const names = new Set(exportsOfSrc().map((e) => e.name));
  assert.ok(names.size > 100, `only ${names.size} exports found across src/; the walk is broken`);
  const phantom = declared.filter((n) => !names.has(n));
  assert.deepEqual(phantom, [], `${MANIFEST} names exports that src/ does not have: ${phantom.join(", ")}`);
});

test("PLANT: the two exports the holdout imports are still exported from src", () => {
  // Named, not derived, because these two are the incident. A future pass that
  // removes them fails here with the reason attached rather than at 03:00 with an
  // anchor at 28 of 30.
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
