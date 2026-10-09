import assert from "node:assert/strict";
import { test } from "node:test";
import { laterPassed, namesPullRequest, promisesFollowUps } from "../src/maintenance.ts";

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
