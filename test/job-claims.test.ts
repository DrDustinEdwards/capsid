import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CLAIM_PRS,
  agreementOf,
  claimRow,
  evaluationRows,
  parseClaim,
  rawJson,
  workerEvaluatorId,
  type JobClaimRow,
} from "../src/job-claims.ts";
import type { GitHubFacts } from "../src/job-outcomes.ts";
import { blockJob, completeJob, failJob } from "../src/jobs.ts";
import { grantAgent } from "../src/agents.ts";
import { fakeEnv } from "./fakes.ts";

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
  "model_id",
  "capsid_sha",
] as const;

// parsing

test("a claim arrives as an object or as a JSON string, and an absent or blank one is no claim", () => {
  const claim = {
    prs_opened: [PR],
    tests: { run: 12, passed: 12, failed: 0, result: "pass" as const },
    deploy_state: "none" as const,
  };
  const asObject = parseClaim(claim);
  const asString = parseClaim(JSON.stringify(claim));
  assert.ok("claim" in asObject && "claim" in asString);
  assert.deepEqual(asObject.claim, claim);
  assert.deepEqual(asString.claim, claim);

  for (const input of [undefined, null, "", "   "]) {
    const parsed = parseClaim(input);
    assert.ok("claim" in parsed, `refused ${JSON.stringify(input)}`);
    assert.equal(parsed.claim, undefined);
  }
});

test("a claim string that is not JSON is REFUSED with the text it was sent, and a claim that is not an object is refused", () => {
  const parsed = parseClaim("{prs_opened: [oops");
  assert.ok("error" in parsed, "an unparseable claim string was accepted");
  assert.match(parsed.error, /not JSON/);
  assert.match(parsed.error, /prs_opened: \[oops/);
  assert.match(parsed.error, /Nothing was written/);

  for (const input of ["null", "[]", "3", '"text"', [PR], 7]) {
    const refused = parseClaim(input);
    assert.ok("error" in refused, `accepted ${JSON.stringify(input)}`);
    assert.match(refused.error, /must be an object/);
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
    {
      prs_opened: Array.from(
        { length: MAX_CLAIM_PRS + 1 },
        (_, i) => `https://github.com/example/sample/pull/${i}`,
      ),
    },
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

test("PLANT: an absent field is NULL, never 0, and a stated zero or empty list is kept as said", () => {
  // No claim and no evidence: every structured column is NULL. A 0 here would read as
  // "counted and found none", which nobody said.
  const empty = row();
  for (const column of NULLABLE)
    assert.equal(
      empty[column],
      null,
      `${column} is ${JSON.stringify(empty[column])} with nothing said`,
    );
  // A partial claim leaves its siblings NULL too.
  const partial = row({ claim: { versions: { client_name: "x" } } });
  assert.equal(partial.model_id, null);

  const said = row({ claim: { prs_opened: [] }, evidence: { commits: 0 } });
  assert.equal(said.prs_opened, 0);
  assert.equal(said.prs_opened_urls, "[]");
  assert.equal(said.commits, 0);
  assert.equal(said.prs_merged, null, "a list nobody named is still NULL");
});

test("prs_opened comes from the claim, else from evidence.prs; prs_merged only from the claim", () => {
  const fromEvidence = row({ evidence: { prs: [PR, PR2] } });
  assert.equal(fromEvidence.prs_opened, 2);
  assert.deepEqual(JSON.parse(fromEvidence.prs_opened_urls ?? "null"), [PR, PR2]);
  assert.equal(fromEvidence.prs_merged, null);
  const fromClaim = row({
    claim: { prs_opened: [PR2], prs_merged: [PR2] },
    evidence: { prs: [PR, PR2] },
  });
  assert.deepEqual(JSON.parse(fromClaim.prs_opened_urls ?? "null"), [PR2]);
  assert.equal(fromClaim.prs_opened, 1);
  assert.equal(fromClaim.prs_merged, 1);
});

test("raw keeps the arguments as sent: JSON strings parsed once, and an unsent key absent rather than null", () => {
  const raw = JSON.parse(
    rawJson({
      evidence: JSON.stringify({ prs: [PR], commits: "two" }),
      claim: { deploy_state: "none" },
      result_summary: "landed",
      result_ref: undefined,
    }),
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
const byName = (rows: ReturnType<typeof evaluationRows>) =>
  Object.fromEntries(rows.map((r) => [r.name, r]));

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
  const claim = row({
    claim: { prs_merged: [PR] },
    evidence: { prs: [PR], commits: 2, files_changed: 1 },
  });
  const rows = byName(
    evaluationRows(
      claim,
      facts({ merged: { [PR]: true }, commits: 3, files_changed: 1, ci_green: 1 }),
      ctx,
    ),
  );
  assert.deepEqual(
    [rows.commits.claimed, rows.commits.verified, rows.commits.agreement],
    ["2", "3", "disagree"],
  );
  assert.equal(rows.commits.score_value, 3);
  assert.equal(
    rows.commits.score_label,
    "fail",
    "a count GitHub contradicts is never labeled pass",
  );
  assert.equal(rows.files_changed.score_label, "pass", "a count GitHub agrees with passes");
  assert.deepEqual(
    [rows.files_changed.claimed, rows.files_changed.verified, rows.files_changed.agreement],
    ["1", "1", "agree"],
  );
  assert.deepEqual(
    [
      rows.pr_merged.claimed,
      rows.pr_merged.verified,
      rows.pr_merged.agreement,
      rows.pr_merged.score_label,
    ],
    ["1", "1", "agree", "pass"],
  );
  assert.deepEqual(
    [rows.prs_opened.claimed, rows.prs_opened.verified, rows.prs_opened.agreement],
    ["1", "1", "agree"],
  );
  // No claim field speaks for CI, so ci_green is unclaimed and still scored.
  assert.deepEqual(
    [
      rows.ci_green.claimed,
      rows.ci_green.verified,
      rows.ci_green.agreement,
      rows.ci_green.score_label,
    ],
    [null, "1", "unclaimed", "pass"],
  );
});

test("a pull request claimed merged that GitHub reads as open fails pr_merged and disagrees", () => {
  const claim = row({ claim: { prs_merged: [PR, PR2] }, evidence: { prs: [PR, PR2] } });
  const rows = byName(
    evaluationRows(claim, facts({ merged: { [PR]: true, [PR2]: false }, ci_green: 0 }), ctx),
  );
  assert.deepEqual(
    [
      rows.pr_merged.claimed,
      rows.pr_merged.verified,
      rows.pr_merged.agreement,
      rows.pr_merged.score_label,
    ],
    ["2", "1", "disagree", "fail"],
  );
  assert.equal(rows.ci_green.score_value, 0);
  assert.equal(rows.ci_green.score_label, "fail");
});

test("a pull request the Worker could not read leaves the check unchecked, with the reason", () => {
  // PR2 is claimed merged but was never read: only evidence.prs and a pull request result_ref are read.
  const claim = row({ claim: { prs_merged: [PR2] }, evidence: { prs: [PR] } });
  const rows = byName(evaluationRows(claim, facts({ merged: { [PR]: true } }), ctx));
  assert.equal(rows.pr_merged.verified, null);
  assert.equal(rows.pr_merged.agreement, "unchecked");
  assert.equal(rows.pr_merged.score_label, "unknown");
  assert.match(rows.pr_merged.explanation ?? "", /could not be read/);
});

// refusals happen before anything is written

test("PLANT: complete, fail and block refuse a bad claim and write nothing", async () => {
  // fakeEnv has no DB, so a handler that reached the database would throw on the
  // missing binding rather than pass quietly.
  const agent = grantAgent("write", "agent:sample-driver");
  const id = "job_abc123abc123";
  const completed = await completeJob(fakeEnv({}), agent, NOW, id, {
    result_summary: "landed",
    claim: "{not json",
  });
  assert.equal(completed.ok, false, "complete accepted an unparseable claim");
  assert.match(completed.refusal ?? "", /not JSON/);
  const failed = await failJob(fakeEnv({}), agent, NOW, id, "broke", {
    claim: { tests: { run: 1, flaky: 2 } } as never,
  });
  assert.equal(failed.ok, false, "fail accepted an unknown claim key");
  assert.match(failed.refusal ?? "", /flaky/);
  const blocked = await blockJob(fakeEnv({}), agent, NOW, id, {
    reason: "needs a push",
    claim: '{"deploy_state":"shipped"}',
  });
  assert.equal(blocked.ok, false, "block accepted a bad deploy_state");
  assert.match(blocked.refusal ?? "", /deploy_state/);
});

// claim.usage: what the session says it used (PR 1 of capsid/research/design-automation-for-speed.md)

const USAGE = {
  cost_usd: 1.25,
  active_seconds: 900.5,
  tokens: { input: 100, output: 200, cache_read: 300, cache_creation: 400 },
};

test("claim.usage parses as an object and as a JSON string, every part is optional, and a bad usage is refused, not trimmed", () => {
  const asObject = parseClaim({ usage: USAGE });
  assert.ok("claim" in asObject && asObject.claim?.usage);
  assert.deepEqual(asObject.claim.usage, USAGE);
  const asString = parseClaim(JSON.stringify({ usage: USAGE }));
  assert.ok("claim" in asString);
  assert.deepEqual(asString.claim?.usage, USAGE);
  for (const part of [{ cost_usd: 0 }, { active_seconds: 12 }, { tokens: { input: 5 } }, {}]) {
    assert.ok("claim" in parseClaim({ usage: part }), `refused ${JSON.stringify(part)}`);
  }

  const cases: unknown[] = [
    { usage: { cost_usd: -0.01 } },
    { usage: { cost_usd: Number.NaN } },
    { usage: { active_seconds: Number.POSITIVE_INFINITY } },
    { usage: { tokens: { input: 1.5 } } },
    { usage: { tokens: { input: -1 } } },
    { usage: { tokens: { total: 5 } } },
    { usage: { currency: "usd" } },
    { usage: "1.25" },
  ];
  for (const input of cases) {
    const parsed = parseClaim(input);
    assert.ok("error" in parsed, `accepted ${JSON.stringify(input)}`);
    assert.match(parsed.error, /^claim was refused, not trimmed/);
  }
});
