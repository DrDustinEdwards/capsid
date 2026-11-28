import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployFindings,
  isLiveGateJob,
  outcomeFrom,
  type DeployRow,
} from "../src/deploy-outcomes.ts";
import { owningCheck } from "../src/watcher-checks.ts";

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

test("outcomeFrom reads the live gate job and its rollback annotation", () => {
  // A refused deploy that was rolled back names where production went, from the step's annotation.
  assert.deepEqual(
    outcomeFrom(job("failure", "success"), [
      `rolled back: was ${A} (this run's commit ${A}), now ${B}. master still points at the bad commit; land a fix or revert it.`,
    ]),
    {
      outcome: "rolled_back",
      rollback_from: A,
      rollback_to: B,
      detail: "the live gate refused the deploy and it was rolled back",
    },
  );
  const failed = outcomeFrom(job("failure", "failure"), [
    `the rollback did not take effect: /health still reports ${A} after 20 reads (this run's commit ${A}).`,
  ]);
  assert.equal(failed?.rollback_to, A);
  for (const [label, gate, notes, outcome] of [
    ["passed", job("success", "skipped"), [], "verified"],
    [
      "guard declined",
      job("failure", "success"),
      ["not rolling back. master and production may disagree; a human decides."],
      "rollback_skipped",
    ],
    ["no annotation", job("failure", "success"), [], "rollback_skipped"],
    [
      "rollback did not take",
      job("failure", "failure"),
      [`the rollback did not take effect: /health still reports ${A}.`],
      "rollback_failed",
    ],
    ["no rollback", job("failure", "skipped"), [], "unverified"],
    ["gate skipped", job("skipped", null), [], undefined],
    ["no gate", undefined, [], undefined],
  ] as const)
    assert.equal(outcomeFrom(gate, [...notes])?.outcome, outcome, label);
});

const row = (outcome: DeployRow["outcome"]): DeployRow => ({
  outcome,
  rollback_from: A,
  rollback_to: B,
  detail: "d",
  run_id: 9,
  head_sha: A,
  pr: 312,
  run_url: "https://github.com/o/r/actions/runs/9",
  run_at: "2026-10-10T00:00:00Z",
  restore_seconds: null,
});

test("a rollback and a failed rollback are findings the deploys check owns; the rest raise none", () => {
  const [rolled] = deployFindings("capsid", row("rolled_back"));
  assert.equal(rolled?.fingerprint, "deploy-rolled-back-capsid");
  assert.match(rolled!.title, /^Watcher: capsid deploy aaaaaaa was rolled back/);
  assert.ok(rolled!.evidence?.some((e) => e.includes(`production went from ${A} back to ${B}`)));
  assert.equal(
    deployFindings("capsid", row("rollback_failed"))[0]?.fingerprint,
    "deploy-rollback-failed-capsid",
  );
  for (const quiet of ["verified", "rollback_skipped", "unverified"] as const)
    assert.deepEqual(deployFindings("capsid", row(quiet)), []);
  assert.equal(owningCheck("deploy-rolled-back-capsid"), "deploys");
  assert.equal(owningCheck("deploy-rollback-failed-capsid"), "deploys");
});

test('isLiveGateJob takes the bare name and a called workflow\'s "<caller> / live gate", nothing looser', () => {
  for (const ok of ["live gate", "deploy / live gate"]) assert.equal(isLiveGateJob(ok), true, ok);
  for (const no of ["live gate 2", "deploy/live gate", "live gates", "xlive gate", "deploy", ""])
    assert.equal(isLiveGateJob(no), false, no);
});
