import assert from "node:assert/strict";
import { test } from "node:test";
import { LINT_DESCRIPTION } from "../src/tools/lint.ts";
import { buildTruthReport } from "../src/truth-report.ts";

// The lint tool description is checked against the report, not a retyped list: the
// check ids are derived from a real buildTruthReport response, which is why the
// description spells the ids as the response spells them. A paraphrase cannot be
// checked against anything.

// The report over an empty store. Every check is pushed whatever the input holds,
// so this is the full id list; `repoPaths: undefined` is the drift check's NOT RUN
// branch, which still pushes. Asserted non-empty below, because a build that
// returned no checks would make the loop pass by reading nothing.
function reportedCheckIds(): string[] {
  const report = buildTruthReport({
    namespace: "sample",
    now: new Date("2026-09-12T00:00:00Z"),
    docs: [],
    edges: [],
    danglingEdges: [],
    countClaims: [],
  });
  return report.checks.map((c) => c.check);
}

test("DERIVED: the lint description names every check the report returns", () => {
  const ids = reportedCheckIds();
  // A build that returned no checks would make the loop pass by reading nothing.
  assert.ok(ids.length >= 6, `buildTruthReport returned only ${ids.length} checks`);
  for (const id of ids) {
    assert.ok(
      LINT_DESCRIPTION.includes(`\`${id}\``),
      `the lint tool description never names the \`${id}\` check, so a client reading it is told about a report that does not exist`,
    );
  }
});
