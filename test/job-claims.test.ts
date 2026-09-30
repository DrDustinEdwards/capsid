import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CLAIM_PRS,
  WORKER_EVALUATIONS,
  agreementOf,
  claimRow,
  evaluationRows,
  parseClaim,
  rawJson,
  workerEvaluatorId,
  type JobClaimRow,
} from "../src/job-claims.ts";
import { verifyEvidence, type GitHubFacts } from "../src/job-outcomes.ts";
import { blockJob, completeJob, failJob } from "../src/jobs.ts";
import { legacyAgent } from "../src/agents.ts";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";

// Claims apart from verified outcomes (migrations/0023, src/job-claims.ts): what node
// can check without a database. The append-only triggers, the one-batch property and
// the claim_id subquery are properties of SQLite, so test-integration/job-claims.test.ts
// checks them on a real D1.

const NOW = new Date("2026-09-29T12:00:00.000Z");
const PR = "https://github.com/example/sample/pull/3";
const PR2 = "https://github.com/example/sample/pull/4";

function row(over: Partial<Parameters<typeof claimRow>[0]> = {}): JobClaimRow {
  return claimRow({
    job_id: "job_abc123abc123",
    action: "complete",
    agent: "agent:sample-driver",
    namespace: "sample",
    raw: {},
    now: NOW,
    ...over,
  });
}

// The nullable columns of job_claims, every one of which is NULL when nothing was said.
const NULLABLE = [
  "prs_opened_urls",
  "prs_merged_urls",
  "prs_opened",
  "prs_merged",
  "commits",
  "files_changed",
  "tests_added",
  "tests_run",
  "tests_passed",
  "tests_failed",
  "tests_result",
  "deploy_state",
  "files_touched",
  "model_id",
  "client_name",
  "client_version",
  "permission_mode",
  "capsid_sha",
] as const;

// parsing

test("a claim arrives as an object or as a JSON string, and both parse to the same claim", () => {
  const claim = { prs_opened: [PR], tests: { run: 12, passed: 12, failed: 0, result: "pass" as const }, deploy_state: "none" as const };
  const asObject = parseClaim(claim);
  const asString = parseClaim(JSON.stringify(claim));
  assert.ok("claim" in asObject && "claim" in asString);
  assert.deepEqual(asObject.claim, claim);
  assert.deepEqual(asString.claim, claim);
});

test("an absent or blank claim is no claim, not a refusal", () => {
  for (const input of [undefined, null, "", "   "]) {
    const parsed = parseClaim(input);
    assert.ok("claim" in parsed, `refused ${JSON.stringify(input)}`);
    assert.equal(parsed.claim, undefined);
  }
});

test("a claim string that is not JSON is REFUSED, with the text it was sent", () => {
  const parsed = parseClaim("{prs_opened: [oops");
  assert.ok("error" in parsed, "an unparseable claim string was accepted");
  assert.match(parsed.error, /not JSON/);
  assert.match(parsed.error, /prs_opened: \[oops/);
  assert.match(parsed.error, /Nothing was written/);
});

test("a claim that is not an object is refused", () => {
  for (const input of ["null", "[]", "3", '"text"', [PR], 7]) {
    const parsed = parseClaim(input);
    assert.ok("error" in parsed, `accepted ${JSON.stringify(input)}`);
    assert.match(parsed.error, /must be an object/);
  }
});

test("PLANT: an unknown key is refused, never dropped, at the top level and inside tests and versions", () => {
  for (const [input, key] of [
    [{ prs_opend: [PR] }, "prs_opend"],
    [JSON.stringify({ tests: { run: 1, skipped: 2 } }), "skipped"],
    [{ versions: { model_id: "m", os: "linux" } }, "os"],
  ] as const) {
    const parsed = parseClaim(input);
    assert.ok("error" in parsed, `the unknown key ${key} was accepted`);
    assert.match(parsed.error, new RegExp(key), `the refusal does not name ${key}`);
    assert.match(parsed.error, /refused, not trimmed/);
  }
});

test("a claim out of bounds is refused, not trimmed", () => {
  const cases: unknown[] = [
    { prs_opened: Array.from({ length: MAX_CLAIM_PRS + 1 }, (_, i) => `https://github.com/example/sample/pull/${i}`) },
    { prs_merged: ["x".repeat(513)] },
    { files_touched: Array.from({ length: 501 }, (_, i) => `src/f${i}.ts`) },
    { tests: { run: -1 } },
    { tests: { passed: 1.5 } },
    { tests: { result: "green" } },
    { deploy_state: "shipped" },
    { versions: { client_version: "v".repeat(129) } },
  ];
  for (const input of cases) {
    const parsed = parseClaim(input);
    assert.ok("error" in parsed, `accepted ${JSON.stringify(input).slice(0, 80)}`);
    assert.match(parsed.error, /^claim was refused/);
  }
});

// the claim row

test("PLANT: an absent field is NULL, never 0", () => {
  // No claim and no evidence: every structured column is NULL. A 0 here would read as
  // "counted and found none", which nobody said.
  const empty = row();
  for (const column of NULLABLE) assert.equal(empty[column], null, `${column} is ${JSON.stringify(empty[column])} with nothing said`);
  // A partial claim leaves its siblings NULL too.
  const partial = row({ claim: { tests: { run: 4 } } });
  assert.equal(partial.tests_run, 4);
  assert.equal(partial.tests_passed, null);
  assert.equal(partial.tests_failed, null);
  assert.equal(partial.tests_result, null);
});

test("a stated zero and a stated empty list are kept as said: 0 and []", () => {
  const said = row({ claim: { prs_opened: [], tests: { failed: 0 } }, evidence: { commits: 0 } });
  assert.equal(said.prs_opened, 0);
  assert.equal(said.prs_opened_urls, "[]");
  assert.equal(said.tests_failed, 0);
  assert.equal(said.commits, 0);
  assert.equal(said.prs_merged, null, "a list nobody named is still NULL");
});

test("prs_opened comes from the claim, else from evidence.prs; prs_merged only from the claim", () => {
  const fromEvidence = row({ evidence: { prs: [PR, PR2] } });
  assert.equal(fromEvidence.prs_opened, 2);
  assert.deepEqual(JSON.parse(fromEvidence.prs_opened_urls ?? "null"), [PR, PR2]);
  assert.equal(fromEvidence.prs_merged, null);
  const fromClaim = row({ claim: { prs_opened: [PR2], prs_merged: [PR2] }, evidence: { prs: [PR, PR2] } });
  assert.deepEqual(JSON.parse(fromClaim.prs_opened_urls ?? "null"), [PR2]);
  assert.equal(fromClaim.prs_opened, 1);
  assert.equal(fromClaim.prs_merged, 1);
});

test("the claim row carries every claim field, the agent, the namespace and the Worker's sha", () => {
  const full = row({
    claim: {
      tests: { run: 10, passed: 9, failed: 1, result: "partial" },
      deploy_state: "pending",
      files_touched: ["src/a.ts", "test/a.test.ts"],
      versions: { model_id: "model-x", client_name: "claude-code", client_version: "9.9.9", permission_mode: "auto" },
    },
    evidence: { commits: 2, files_changed: 3, tests_added: 4 },
    capsid_sha: "abc1234",
  });
  assert.equal(full.agent, "agent:sample-driver");
  assert.equal(full.namespace, "sample");
  assert.equal(full.action, "complete");
  assert.deepEqual([full.tests_run, full.tests_passed, full.tests_failed, full.tests_result], [10, 9, 1, "partial"]);
  assert.equal(full.deploy_state, "pending");
  assert.deepEqual(JSON.parse(full.files_touched ?? "null"), ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual([full.model_id, full.client_name, full.client_version, full.permission_mode], ["model-x", "claude-code", "9.9.9", "auto"]);
  assert.deepEqual([full.commits, full.files_changed, full.tests_added], [2, 3, 4]);
  assert.equal(full.capsid_sha, "abc1234");
  assert.equal(full.recorded_at, NOW.toISOString(), "recorded_at is ISO with milliseconds, bound from code");
});

test("raw keeps the arguments as sent: JSON strings parsed once, and an unsent key absent rather than null", () => {
  const raw = JSON.parse(
    rawJson({
      evidence: JSON.stringify({ prs: [PR], commits: "two" }),
      claim: { deploy_state: "none" },
      result_summary: "landed",
      result_ref: undefined,
    })
  ) as Record<string, unknown>;
  // The evidence exactly as the driver sent it, including the field parseEvidence
  // would drop.
  assert.deepEqual(raw.evidence, { prs: [PR], commits: "two" });
  assert.deepEqual(raw.claim, { deploy_state: "none" });
  assert.equal(raw.result_summary, "landed");
  assert.deepEqual(Object.keys(raw).sort(), ["claim", "evidence", "result_summary"]);
});

// evaluations

test("agreement: unclaimed, unchecked, agree, disagree, and 0 is a claim", () => {
  assert.equal(agreementOf(null, 3), "unclaimed");
  assert.equal(agreementOf(null, null), "unclaimed");
  assert.equal(agreementOf(2, null), "unchecked");
  assert.equal(agreementOf(3, 3), "agree");
  assert.equal(agreementOf(2, 3), "disagree");
  assert.equal(agreementOf(0, 0), "agree", "a stated zero is a claim, not an absence");
  assert.equal(agreementOf(0, null), "unchecked");
});

const ctx = { evaluator_id: workerEvaluatorId("abc1234"), now: NOW };
const facts = (over: Partial<GitHubFacts> = {}): { github: GitHubFacts } => ({
  github: { merged: {}, commits: null, files_changed: null, ci_green: null, ...over },
});
const byName = (rows: ReturnType<typeof evaluationRows>) => Object.fromEntries(rows.map((r) => [r.name, r]));

test("the worker writes exactly its five checks, each named by evaluator and sha", () => {
  const rows = evaluationRows(row(), facts(), ctx);
  assert.deepEqual(rows.map((r) => r.name), [...WORKER_EVALUATIONS]);
  for (const r of rows) {
    assert.equal(r.evaluator, "worker");
    assert.equal(r.evaluator_id, "capsid@abc1234");
  }
  assert.equal(workerEvaluatorId(undefined), "capsid@unknown");
});

test("PLANT: nothing claimed and nothing checked is NULL and unknown, never 0 or fail", () => {
  for (const r of evaluationRows(row(), facts(), ctx)) {
    assert.equal(r.claimed, null, `${r.name} claimed`);
    assert.equal(r.verified, null, `${r.name} verified`);
    assert.equal(r.score_value, null, `${r.name} score_value`);
    assert.equal(r.score_label, "unknown", `${r.name} score_label`);
    assert.equal(r.agreement, "unclaimed", `${r.name} agreement`);
  }
});

test("claim and verified side by side: a driver's count GitHub contradicts is a disagreement", () => {
  const claim = row({ claim: { prs_merged: [PR] }, evidence: { prs: [PR], commits: 2, files_changed: 1 } });
  const rows = byName(evaluationRows(claim, facts({ merged: { [PR]: true }, commits: 3, files_changed: 1, ci_green: 1 }), ctx));
  assert.deepEqual([rows.commits.claimed, rows.commits.verified, rows.commits.agreement], ["2", "3", "disagree"]);
  assert.equal(rows.commits.score_value, 3);
  assert.equal(rows.commits.score_label, "pass", "a count is pass when GitHub answered");
  assert.deepEqual([rows.files_changed.claimed, rows.files_changed.verified, rows.files_changed.agreement], ["1", "1", "agree"]);
  assert.deepEqual([rows.pr_merged.claimed, rows.pr_merged.verified, rows.pr_merged.agreement, rows.pr_merged.score_label], ["1", "1", "agree", "pass"]);
  assert.deepEqual([rows.prs_opened.claimed, rows.prs_opened.verified, rows.prs_opened.agreement], ["1", "1", "agree"]);
  // No claim field speaks for CI, so ci_green is unclaimed and still scored.
  assert.deepEqual([rows.ci_green.claimed, rows.ci_green.verified, rows.ci_green.agreement, rows.ci_green.score_label], [null, "1", "unclaimed", "pass"]);
});

test("a pull request claimed merged that GitHub reads as open fails pr_merged and disagrees", () => {
  const claim = row({ claim: { prs_merged: [PR, PR2] }, evidence: { prs: [PR, PR2] } });
  const rows = byName(evaluationRows(claim, facts({ merged: { [PR]: true, [PR2]: false }, ci_green: 0 }), ctx));
  assert.deepEqual([rows.pr_merged.claimed, rows.pr_merged.verified, rows.pr_merged.agreement, rows.pr_merged.score_label], ["2", "1", "disagree", "fail"]);
  assert.equal(rows.ci_green.score_value, 0);
  assert.equal(rows.ci_green.score_label, "fail");
});

test("a pull request the Worker could not read leaves the check unchecked, with the reason", () => {
  // PR2 is claimed merged but was never read: only evidence.prs is read.
  const claim = row({ claim: { prs_merged: [PR2] }, evidence: { prs: [PR] } });
  const rows = byName(evaluationRows(claim, facts({ merged: { [PR]: true } }), ctx));
  assert.equal(rows.pr_merged.verified, null);
  assert.equal(rows.pr_merged.agreement, "unchecked");
  assert.equal(rows.pr_merged.score_label, "unknown");
  assert.match(rows.pr_merged.explanation ?? "", /could not be read/);
});

// verifyEvidence exposes what GitHub said, beside the driver's numbers

function envWithRepo() {
  return fakeEnv({
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ repos: JSON.stringify([{ repo: "example/sample", label: "primary" }]) }) }) }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}
const HEAD = "b".repeat(40);
const prRoute = (merged: boolean, commits: number, changed: number): Route => ({ body: { merged, commits, changed_files: changed, head: { sha: HEAD } } });
const greenRuns: Route = {
  body: { workflow_runs: [{ id: 1, name: "ci", head_sha: HEAD, status: "completed", conclusion: "success", event: "push", created_at: "x", html_url: "u" }] },
};

test("PLANT: the claim row keeps the driver's count when GitHub's differs", async () => {
  // The driver says two commits and one file; GitHub says five and eight. job_outcomes
  // keeps GitHub's (unchanged); the claim keeps the driver's; the evaluation holds both.
  await withFetch(
    { "GET /repos/example/sample/pulls/3": prRoute(true, 5, 8), "GET /repos/example/sample/actions/runs": greenRuns },
    async () => {
      const evidence = { prs: [PR], commits: 2, files_changed: 1, tests_added: 4 };
      const claim = row({ evidence, claim: { prs_merged: [PR] } });
      const verdict = await verifyEvidence(envWithRepo(), "sample", evidence);
      assert.equal(verdict.commits, 5, "job_outcomes' value stopped being GitHub's");
      assert.equal(claim.commits, 2, "the claim row took GitHub's count");
      assert.equal(claim.files_changed, 1);
      assert.deepEqual(verdict.github, { merged: { [PR]: true }, commits: 5, files_changed: 8, ci_green: 1 });
      assert.deepEqual(verdict.reported, { prs: [PR], commits: 2, files_changed: 1, tests_added: 4 });
      const rows = byName(evaluationRows(claim, verdict, ctx));
      assert.deepEqual([rows.commits.claimed, rows.commits.verified, rows.commits.agreement], ["2", "5", "disagree"]);
      assert.deepEqual([rows.files_changed.claimed, rows.files_changed.verified], ["1", "8"]);
    }
  );
});

test("verifyEvidence with nothing to read exposes NULL facts, never 0 or false", async () => {
  const verdict = await verifyEvidence(fakeEnv({}), "sample", { commits: 0 });
  assert.deepEqual(verdict.github, { merged: {}, commits: null, files_changed: null, ci_green: null });
  assert.deepEqual(verdict.reported, { prs: null, commits: 0, files_changed: null, tests_added: null });
});

// refusals happen before anything is written

test("PLANT: complete, fail and block refuse a bad claim and write nothing", async () => {
  // fakeEnv has no DB, so a handler that reached the database would throw on the
  // missing binding rather than pass quietly.
  const agent = legacyAgent("write", "agent:sample-driver");
  const id = "job_abc123abc123";
  const completed = await completeJob(fakeEnv({}), agent, NOW, id, { result_summary: "landed", claim: "{not json" });
  assert.equal(completed.ok, false, "complete accepted an unparseable claim");
  assert.match(completed.refusal ?? "", /not JSON/);
  const failed = await failJob(fakeEnv({}), agent, NOW, id, "broke", undefined, { claim: { tests: { run: 1, flaky: 2 } } as never });
  assert.equal(failed.ok, false, "fail accepted an unknown claim key");
  assert.match(failed.refusal ?? "", /flaky/);
  const blocked = await blockJob(fakeEnv({}), agent, NOW, id, { reason: "needs a push", claim: '{"deploy_state":"shipped"}' });
  assert.equal(blocked.ok, false, "block accepted a bad deploy_state");
  assert.match(blocked.refusal ?? "", /deploy_state/);
});
