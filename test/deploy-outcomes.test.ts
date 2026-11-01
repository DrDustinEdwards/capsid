import assert from "node:assert/strict";
import { test } from "node:test";
import { deployFindings, isLiveGateJob, outcomeFrom, type DeployRow } from "../src/deploy-outcomes.ts";
import { owningCheck } from "../src/watcher-checks.ts";

// The memory of a rollback (docs/design/design-merge-pipeline.md section 6, PR 6): what a
// live gate job's conclusion, its rollback step and its annotations say, and the finding
// a rollback raises. The read against GitHub and D1 is in test-integration/deploy-outcomes.test.ts.

const A = "a".repeat(40);
const B = "b".repeat(40);
const job = (conclusion: string | null, rollback: string | null) => ({
  id: 7,
  name: "live gate",
  conclusion,
  steps: [
    { name: "verify:live", conclusion: conclusion === "success" ? "success" : "failure" },
    { name: "Roll back the deploy this run shipped", conclusion: rollback },
  ],
});

test("a passing live gate is verified", () => {
  assert.deepEqual(outcomeFrom(job("success", "skipped"), []), { outcome: "verified", rollback_from: null, rollback_to: null, detail: "the live gate passed" });
});

test("PLANT: a refused deploy that was rolled back is rolled_back, with where production went, from the step's annotation", () => {
  const read = outcomeFrom(job("failure", "success"), [`rolled back: was ${A} (this run's commit ${A}), now ${B}. master still points at the bad commit; land a fix or revert it.`]);
  assert.deepEqual(read, { outcome: "rolled_back", rollback_from: A, rollback_to: B, detail: "the live gate refused the deploy and it was rolled back" });
});

test("a rollback the guard declined is rollback_skipped, not rolled_back", () => {
  assert.equal(outcomeFrom(job("failure", "success"), ["not rolling back. master and production may disagree; a human decides."])?.outcome, "rollback_skipped");
  // A rollback step that succeeded and said nothing is not taken for a rollback.
  assert.equal(outcomeFrom(job("failure", "success"), [])?.outcome, "rollback_skipped");
});

test("a rollback that did not take effect is rollback_failed, naming what production still serves", () => {
  const read = outcomeFrom(job("failure", "failure"), [`the rollback did not take effect: /health still reports ${A} after 20 reads (this run's commit ${A}).`]);
  assert.equal(read?.outcome, "rollback_failed");
  assert.equal(read?.rollback_to, A);
});

test("a gate that failed with no rollback is unverified, and a skipped or missing gate records nothing", () => {
  assert.equal(outcomeFrom(job("failure", "skipped"), [])?.outcome, "unverified");
  assert.equal(outcomeFrom(job("skipped", null), []), null);
  assert.equal(outcomeFrom(undefined, []), null);
});

const row = (outcome: DeployRow["outcome"]): DeployRow => ({ outcome, rollback_from: A, rollback_to: B, detail: "d", run_id: 9, head_sha: A, pr: 312, run_url: "https://github.com/o/r/actions/runs/9", run_at: "2026-10-10T00:00:00Z", restore_seconds: null });

test("a rollback and a failed rollback are findings the deploys check owns; the rest raise none", () => {
  const [rolled] = deployFindings("capsid", row("rolled_back"));
  assert.equal(rolled?.fingerprint, "deploy-rolled-back-capsid");
  assert.match(rolled!.title, /^Watcher: capsid deploy aaaaaaa was rolled back/);
  assert.ok(rolled!.evidence?.some((e) => e.includes(`production went from ${A} back to ${B}`)));
  assert.equal(deployFindings("capsid", row("rollback_failed"))[0]?.fingerprint, "deploy-rollback-failed-capsid");
  for (const quiet of ["verified", "rollback_skipped", "unverified"] as const) assert.deepEqual(deployFindings("capsid", row(quiet)), []);
  assert.equal(owningCheck("deploy-rolled-back-capsid"), "deploys");
  assert.equal(owningCheck("deploy-rollback-failed-capsid"), "deploys");
  // deploy-drift stays the master-head check's.
  assert.equal(owningCheck("deploy-drift-capsid"), "master head");
});

test("isLiveGateJob takes the bare name and a called workflow's \"<caller> / live gate\", nothing looser", () => {
  for (const ok of ["live gate", "deploy / live gate"]) assert.equal(isLiveGateJob(ok), true, ok);
  for (const no of ["live gate 2", "deploy/live gate", "live gates", "xlive gate", "deploy", ""]) assert.equal(isLiveGateJob(no), false, no);
});

