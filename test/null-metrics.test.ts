import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPORTED_SECONDARY } from "../scripts/improve-report.mjs";
import { parseScoresDoc, seedScoresDoc } from "../src/improve-scores";
import { ROSTER } from "../src/improve-schema";

// A declared metric that nothing reports is a false claim in the scores document.
// The scores canon and the scorer are checked against each other in both directions,
// so a metric cannot be declared without something reporting it, or reported without
// being declared.

const SCORER = join(import.meta.dirname, "..", "scripts", "improve-report.mjs");

function signedBody(): { secondary: Record<string, number | null> } {
  const dir = mkdtempSync(join(tmpdir(), "capsid-null-metrics-"));
  const metricsPath = join(dir, "metrics.json");
  writeFileSync(metricsPath, JSON.stringify({ bundle_size_bytes: 4242 }));
  return JSON.parse(
    execFileSync(process.execPath, [SCORER, metricsPath, "30", "30"], {
      encoding: "utf8",
      env: {
        ...process.env,
        IMPROVE_NAMESPACE: "capsid",
        RUN_ID: "r1",
        ATTEMPT_ID: "a1",
        ATTEMPT_HEAD_SHA: "deadbeef",
        BUILD_PASSES: "1",
        SECONDARY_TEST_PASS_RATE: "0.9",
        SECONDARY_LINT_COUNT: "3",
      },
    })
  );
}

test("PLANT: the signed report carries no metric that nothing measures", () => {
  const body = signedBody();
  assert.deepEqual(
    Object.keys(body.secondary),
    REPORTED_SECONDARY,
    "the report's secondary block is exactly the wired metrics, in order"
  );
  assert.ok(!("error_count" in body.secondary), "error_count was null on every run ever posted");
  assert.ok(!("p95_latency_ms" in body.secondary), "p95_latency_ms was null on every run ever posted");
});

test("PLANT: the seed document declares no metric the scorer does not report", () => {
  for (const namespace of ROSTER) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    assert.deepEqual(doc.problems, [], `${namespace}'s seed document must parse cleanly`);
    const declared = doc.secondary.map((s) => s.metric);
    assert.deepEqual(
      declared,
      REPORTED_SECONDARY,
      `${namespace} declares ${JSON.stringify(declared)}; the scorer reports ${JSON.stringify(REPORTED_SECONDARY)}`
    );
  }
});

test("PLANT: no namespace parks an intention as a stub", () => {
  // The `stub` marker is for a metric that is genuinely half-wired, not for planned
  // work (that lives in capsid/improve/TASK-wire-the-metrics.md).
  for (const namespace of ROSTER) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    const stubs = doc.secondary.filter((s) => s.stub).map((s) => s.metric);
    assert.deepEqual(stubs, [], `${namespace} still declares stub metrics: ${stubs.join(", ")}`);
  }
});

test("the parser still understands a stub, for the day one is genuinely half-wired", () => {
  // Removing the stubs from the canon must not remove the ability to declare one.
  const doc = parseScoresDoc(
    "capsid",
    ["## Anchors", "", "- build_passes: required", "", "## Secondary", "", "- half_wired: maximize weight 0 stub", ""].join("\n")
  );
  assert.deepEqual(doc.problems, []);
  assert.equal(doc.secondary.length, 1);
  assert.equal(doc.secondary[0].stub, true);
});

test("the anchor block is untouched by any of this, so no pin moves", () => {
  // Removing a Secondary line cannot change the anchor checksum: sectionSlice stops
  // at the next `## ` heading.
  for (const namespace of ROSTER) {
    const doc = parseScoresDoc(namespace, seedScoresDoc(namespace));
    assert.ok(doc.anchorBlock.startsWith("## Anchors"), "the block starts at the heading");
    assert.ok(!doc.anchorBlock.includes("## Secondary"), "and stops before the tunable section");
    assert.ok(!doc.anchorBlock.includes("bundle_size_bytes"), "no secondary metric is inside the checksummed block");
  }
});
