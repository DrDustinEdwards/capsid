import assert from "node:assert/strict";
import { test } from "node:test";
import { laterPassed, namesPullRequest, promisesFollowUps } from "../src/maintenance.ts";
import { gatherPrItems, greenAwaitingSeat, redTooLong, type OpenPr, type PrCheck, type PrReaders } from "../src/maintenance-prs.ts";

// The daily maintenance pass's pure rules (job_549550d73d4e). Each rule is seen firing on a
// planted case and staying quiet on a clean one. The queries that feed them run against a
// real D1 in test-integration/maintenance.test.ts.

test("a queued LATER job is listed once its date has passed, and not before", () => {
  const jobs = [
    { id: "job_a", namespace: "sample", title: "LATER 2026-10-01: move the cron" },
    { id: "job_b", namespace: "sample", title: "LATER (after 2026-12-01) rename the tool" },
    { id: "job_c", namespace: "sample", title: "Ordinary job with a date 2026-01-01 in it" },
  ];
  const items = laterPassed(jobs, "2026-10-08");
  assert.deepEqual(items.map((i) => i.job), ["job_a"]);
  assert.equal(items[0].rule, "later-passed");
  assert.match(items[0].line, /LATER 2026-10-01/);
  assert.deepEqual(laterPassed(jobs, "2026-09-30"), [], "nothing is stale before the earliest date");
});

test("a pull request URL matches as a whole number, never as the prefix of a longer one", () => {
  const url = "https://github.com/example-org/sample/pull/1";
  assert.equal(namesPullRequest(`see ${url} for the change`, url), true);
  assert.equal(namesPullRequest(`see ${url}`, url), true, "at the end of the text");
  assert.equal(namesPullRequest("see https://github.com/example-org/sample/pull/12", url), false);
  assert.equal(namesPullRequest("see https://github.com/example-org/sample/pull/12 and https://github.com/example-org/sample/pull/1.", url), true, "a later whole match still counts");
  assert.equal(namesPullRequest("no link here", url), false);
});

test("a promise of follow-up jobs is recognised in the ways drivers write it", () => {
  assert.equal(promisesFollowUps("Piece 1 done. The rest will follow as separate jobs."), true);
  assert.equal(promisesFollowUps("Follow-ups to be posted as separate job after the merge"), true);
  assert.equal(promisesFollowUps("Done. Nothing further."), false);
  assert.equal(promisesFollowUps("A separate job covers the audit."), false, "a separate job without a promise of follow-ups");
  assert.equal(promisesFollowUps(null), false);
});

// The pull request rules (piece 2). A fake reader stands in for GitHub; the real readers
// make the auto-merge tick's reads (src/maintenance-prs.ts).

const NOW = new Date("2026-10-08T12:00:00.000Z");
const check = (over: Partial<PrCheck> = {}): PrCheck => ({
  id: 1, name: "test", status: "completed", conclusion: "success", completed_at: "2026-10-08T10:00:00.000Z", actions: true, ...over,
});
const pr = (number: number, over: Partial<OpenPr> = {}): OpenPr => ({
  number, url: `https://github.com/example-org/sample/pull/${number}`, draft: false,
  created_at: "2026-10-05T12:00:00.000Z", job: "job_000000000001", checks: [check()], ...over,
});
const readers = (prs: OpenPr[], step: { step: string | null; problem: string | null } = { step: "Run unit tests", problem: null }): PrReaders => ({
  openPrs: async () => ({ repo: "example-org/sample", prs, problem: null }),
  failingStep: async () => step,
});

test("a green driver pull request is listed with its age, and a red, pending, draft or job-less one is not", () => {
  const prs = [
    pr(1),
    pr(2, { checks: [check({ conclusion: "failure" })] }),
    pr(3, { checks: [check({ status: "in_progress", conclusion: null })] }),
    pr(4, { draft: true }),
    pr(5, { job: null }),
    pr(6, { checks: [] }),
  ];
  const items = greenAwaitingSeat("sample", prs, NOW);
  assert.deepEqual(items.map((i) => i.pr), [prs[0].url]);
  assert.equal(items[0].rule, "pr-awaiting-seat");
  assert.equal(items[0].job, "job_000000000001");
  assert.match(items[0].line, /open 3\.0 days/);
  assert.deepEqual(greenAwaitingSeat("sample", prs.slice(1), NOW), [], "no green driver pull request, nothing listed");
});

test("a pull request red for more than 48 hours is listed from its first failure, and a newer red one is not", () => {
  const old = pr(7, { job: null, checks: [check({ name: "lint", conclusion: "failure", completed_at: "2026-10-06T08:00:00.000Z" }), check({ name: "test", conclusion: "failure", completed_at: "2026-10-05T08:00:00.000Z" })] });
  const fresh = pr(8, { checks: [check({ conclusion: "failure", completed_at: "2026-10-07T08:00:00.000Z" })] });
  const green = pr(9);
  const red = redTooLong([old, fresh, green], NOW);
  assert.deepEqual(red.map((r) => r.pr.number), [7]);
  assert.equal(red[0].check.name, "test", "the earliest failure is when it went red");
  assert.equal(red[0].since, "2026-10-05T08:00:00.000Z");
  assert.deepEqual(redTooLong([fresh, green], NOW), []);
});

test("the gathered list names the failing step, counts what it read, and stays quiet on a clean repo", async () => {
  const red = pr(7, { checks: [check({ conclusion: "failure", completed_at: "2026-10-05T08:00:00.000Z" })] });
  const got = await gatherPrItems(["sample"], readers([red, pr(9)]), NOW);
  assert.deepEqual(got.items.map((i) => i.rule).sort(), ["pr-awaiting-seat", "pr-red"]);
  assert.match(got.items.find((i) => i.rule === "pr-red")!.line, /red for 3\.2 days: "test" failed at step "Run unit tests"/);
  assert.deepEqual(got.read, { sample: 2 });

  const clean = await gatherPrItems(["sample"], readers([pr(9, { job: null })]), NOW);
  assert.deepEqual(clean.items, []);
  assert.deepEqual(clean.read, { sample: 1 }, "quiet with one pull request read, not quiet on nothing read");

  const unread = await gatherPrItems(["sample"], readers([red], { step: null, problem: "the job read returned 404" }), NOW);
  assert.match(unread.items[0].line, /its step was not read \(the job read returned 404\)/);
});

test("a GitHub read that fails is listed as not checked, never read as clean", async () => {
  const throwing: PrReaders = { openPrs: async () => { throw new Error("GitHub answered 502"); }, failingStep: async () => ({ step: null, problem: null }) };
  const failed = await gatherPrItems(["sample"], throwing, NOW);
  assert.deepEqual(failed.items.map((i) => i.rule), ["prs-not-checked"]);
  assert.match(failed.items[0].line, /GitHub answered 502/);
  assert.deepEqual(failed.read, {}, "a namespace not read has no count");

  const partial: PrReaders = { openPrs: async () => ({ repo: "example-org/sample", prs: [], problem: "#3 check runs: page 1 returned 500" }), failingStep: async () => ({ step: null, problem: null }) };
  const part = await gatherPrItems(["sample"], partial, NOW);
  assert.deepEqual(part.items.map((i) => i.rule), ["prs-not-checked"]);
  assert.match(part.items[0].line, /#3 check runs/);
});
