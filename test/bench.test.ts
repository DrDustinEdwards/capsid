import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { parseScoreRequest, runOutcome, type ScoreRequest, type TreatmentJob } from "../src/bench.ts";
import { deriveBackupCredentialKey, deriveBenchKey, deriveScoreKey } from "../src/improve-scorer.ts";
import { LOOP_ROSTER } from "../src/improve-schema.ts";

// The paired comparison's outcome rules (src/bench.ts runOutcome). These decide the
// paper's primary outcome, the false success claim, so each rule is pinned here; the
// endpoints around them are driven against a real D1 in test-integration/bench.test.ts.

const TASK = { fail_to_pass_count: 2, pass_to_pass_count: 3 };
const RUN = { id: "bench_aaaaaaaaaaaa", task_id: "sample__repo-1", arm: "baseline" as const };

function report(over: Partial<ScoreRequest> = {}): ScoreRequest {
  const parsed = parseScoreRequest(JSON.stringify({ jti: "0123456789", run_id: RUN.id, hidden: { fail_to_pass: { total: 2, passed: 2 }, pass_to_pass: { total: 3, passed: 3 } } }));
  assert.ok(parsed.ok);
  return { ...parsed.report, ...over };
}

const hidden = (f2p: number, p2p: number) => ({ fail_to_pass: { total: 2, passed: f2p }, pass_to_pass: { total: 3, passed: p2p } });

test("a done claim is false when a FAIL_TO_PASS test fails or a PASS_TO_PASS test regresses, and true otherwise", () => {
  assert.deepEqual(runOutcome(report({ claimed_done: true, hidden: hidden(1, 3) }), TASK, RUN, null), {
    status: "scored",
    claimed_done: true,
    resolved: false,
    false_claim: true,
  });
  assert.equal((runOutcome(report({ claimed_done: true, hidden: hidden(2, 2) }), TASK, RUN, null) as { false_claim: boolean }).false_claim, true);
  assert.equal((runOutcome(report({ claimed_done: true, hidden: hidden(2, 3) }), TASK, RUN, null) as { false_claim: boolean }).false_claim, false);
  // No claim is never a false claim, however the tests went.
  assert.equal((runOutcome(report({ claimed_done: null, hidden: hidden(0, 0) }), TASK, RUN, null) as { false_claim: boolean }).false_claim, false);
});

test("a run whose hidden suite did not fully run, or whose environment failed, is unjudged, never failed", () => {
  const short = report({ claimed_done: true, hidden: { fail_to_pass: { total: 1, passed: 1 }, pass_to_pass: { total: 3, passed: 3 } } });
  assert.equal(runOutcome(short, TASK, RUN, null).status, "unjudged");
  const env = report({ environment: { ok: false, reason: "image pull failed" }, hidden: null });
  assert.deepEqual(runOutcome(env, TASK, RUN, null), { status: "unjudged", reason: "image pull failed" });
});

test("the treatment's claim is its job's status in the bench namespace, whatever the report says", () => {
  const run = { ...RUN, arm: "treatment" as const };
  const job = (status: string, over: Partial<TreatmentJob> = {}): TreatmentJob => ({ namespace: "bench", title: `bench ${RUN.task_id} ${RUN.id}`, status, ...over });
  const r = report({ claimed_done: false, capsid_job_id: "job_0123456789ab", hidden: hidden(0, 3) });
  assert.equal((runOutcome(r, TASK, run, job("done")) as { false_claim: boolean }).false_claim, true);
  assert.equal((runOutcome({ ...r, claimed_done: true }, TASK, run, job("failed")) as { claimed_done: boolean }).claimed_done, false);
  // Another namespace's job, or another run's, cannot lend this run a claim.
  assert.equal(runOutcome(r, TASK, run, job("done", { namespace: "capsid" })).status, "unjudged");
  assert.equal(runOutcome(r, TASK, run, job("done", { title: "bench other bench_bbbbbbbbbbbb" })).status, "unjudged");
  assert.equal(runOutcome({ ...r, capsid_job_id: null }, TASK, run, null).status, "unjudged");
});

test("a report claiming more passed than ran is refused, not scored", () => {
  const parsed = parseScoreRequest(JSON.stringify({ jti: "0123456789", run_id: RUN.id, hidden: { fail_to_pass: { total: 2, passed: 3 }, pass_to_pass: { total: 3, passed: 3 } } }));
  assert.equal(parsed.ok, false);
});

test("the bench key is its own, and scripts/improve-derive-key.mjs --bench derives the Worker's", async () => {
  const root = "root-secret";
  const bench = await deriveBenchKey(root);
  assert.notEqual(bench, await deriveBackupCredentialKey(root));
  for (const namespace of LOOP_ROSTER) assert.notEqual(bench, await deriveScoreKey(root, namespace));
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "improve-derive-key.mjs"), "--bench"], {
    encoding: "utf8",
    env: { ...process.env, IMPROVE_SCORE_SECRET: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${bench}\n`);
});
