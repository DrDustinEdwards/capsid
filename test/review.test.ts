import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseVerdict,
  reviewCaller,
  reviewScope,
  REVIEW_OWNER_ID,
  toolArguments,
} from "../src/review.ts";

// The gate on who may spend a review: the one shared workflow, on a pull request, in a
// repository Dustin owns. Any of the three missing is a refusal.
test("reviewCaller admits devkit's review.yml on a pull request in Dustin's repository and nothing else", () => {
  const claims = {
    repository: "DrDustinEdwards/foxing",
    repository_owner_id: REVIEW_OWNER_ID,
    job_workflow_ref:
      "DrDustinEdwards/devkit/.github/workflows/review.yml@0123456789abcdef0123456789abcdef01234567",
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
  };
  assert.deepEqual(reviewCaller(claims), { owner: "DrDustinEdwards", repo: "foxing", pr: 42 });
  assert.ok("refusal" in reviewCaller({ ...claims, repository_owner_id: "1" }), "another owner");
  assert.ok(
    "refusal" in
      reviewCaller({
        ...claims,
        job_workflow_ref: "DrDustinEdwards/foxing/.github/workflows/review.yml@refs/heads/main",
      }),
    "a workflow of the repository's own",
  );
  assert.ok(
    "refusal" in
      reviewCaller({
        ...claims,
        job_workflow_ref: "Someone/devkit/.github/workflows/review.yml@main",
      }),
    "a fork of devkit",
  );
  assert.ok(
    "refusal" in reviewCaller({ ...claims, event_name: "push", ref: "refs/heads/main" }),
    "a push",
  );
});

// The model's answer is held to the check's shape: the tool call's arguments are read in either
// shape Workers AI answers with, an unknown verdict is no verdict, and a finding on a file the
// diff does not touch, or of a kind not reported, is dropped.
test("toolArguments and parseVerdict keep a known verdict and only findings on changed files", () => {
  const changed = new Set(["src/a.ts"]);
  const args = {
    verdict: "changes",
    summary: "One bug.",
    findings: [
      { kind: "Bug", file: "b/src/a.ts", line: 12, note: "Off by one." },
      { kind: "bug", file: "src/invented.ts", line: 3, note: "Not in the diff." },
      { kind: "style", file: "src/a.ts", line: 4, note: "Not a kind we report." },
    ],
  };
  const expected = {
    verdict: "CHANGES",
    summary: "One bug.",
    findings: [{ kind: "bug", file: "src/a.ts", line: 12, note: "Off by one." }],
  };
  assert.deepEqual(
    parseVerdict(
      toolArguments({ tool_calls: [{ name: "report_review", arguments: args }] }),
      changed,
    ),
    expected,
  );
  const openAi = {
    choices: [
      {
        message: {
          tool_calls: [{ function: { name: "report_review", arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
  assert.deepEqual(parseVerdict(toolArguments(openAi), changed), expected);
  assert.equal(parseVerdict({ verdict: "MAYBE", findings: [] }, changed), null);
  assert.equal(parseVerdict(toolArguments({ response: "I could not decide." }), changed), null);
});

test("reviewScope skips documents, tests and lockfiles alone and reviews any code", () => {
  assert.equal(
    reviewScope([
      { filename: "README.md" },
      { filename: "test/a.test.ts" },
      { filename: "package-lock.json" },
    ]).review,
    false,
  );
  assert.equal(
    reviewScope([{ filename: "README.md" }, { filename: "apps/web/app/routes/home.tsx" }]).review,
    true,
  );
  assert.equal(reviewScope([]).review, false);
});
