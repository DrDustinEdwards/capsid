import assert from "node:assert/strict";
import { test } from "node:test";
import {
  keepReview,
  reviewCaller,
  reviewKey,
  reviewScope,
  skippable,
  REVIEW_OWNER_ID,
} from "../src/review.ts";
import { parseVerdict, toolArguments } from "../src/review-answer.ts";

test("reviewCaller admits devkit's review.yml or pr.yml on a pull request in Dustin's repository and nothing else", () => {
  const claims = {
    repository: "DrDustinEdwards/foxing",
    repository_owner_id: REVIEW_OWNER_ID,
    job_workflow_ref:
      "DrDustinEdwards/devkit/.github/workflows/review.yml@0123456789abcdef0123456789abcdef01234567",
    event_name: "pull_request",
    ref: "refs/pull/42/merge",
  };
  assert.deepEqual(reviewCaller(claims), { owner: "DrDustinEdwards", repo: "foxing", pr: 42 });
  assert.deepEqual(
    reviewCaller({
      ...claims,
      job_workflow_ref:
        "DrDustinEdwards/devkit/.github/workflows/pr.yml@0123456789abcdef0123456789abcdef01234567",
    }),
    { owner: "DrDustinEdwards", repo: "foxing", pr: 42 },
  );
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
      { filename: "dashboard/src/styles.css" },
    ]).review,
    false,
  );
  assert.equal(
    reviewScope([{ filename: "README.md" }, { filename: "apps/web/app/routes/home.tsx" }]).review,
    true,
  );
  assert.equal(
    reviewScope([{ filename: "docs/a.md", previous_filename: "src/a.ts" }]).review,
    true,
    "a rename is judged under both names",
  );
  assert.equal(reviewScope([]).review, false);
});

test("money, migrations, CI, scripts and deploy configuration are never skipped", () => {
  for (const path of [
    "app/billing/charge.md",
    "src/payments.ts",
    "test/stripe-client.test.ts",
    "routes/checkout/index.tsx",
    "docs/invoice-pdf.md",
    "migrations/0040_x.sql",
    "test/fixtures/migrations/0001.sql",
    ".github/workflows/ci.yml",
    "scripts/README.md",
    "workers/cron/test/a.test.ts",
    "wrangler.jsonc.example",
    "tsconfig.test.json",
    ".dev.vars.example",
  ])
    assert.equal(skippable(path), false, path);
  for (const path of [
    "app/routes/billboards.md",
    "docs/repayment-history.md",
    "test/unsubscribe-token.test.ts",
    "package.json",
    "dashboard/src/styles.css",
  ])
    assert.equal(skippable(path), true, path);
});

test("a verdict is kept per head commit, so a later push is reviewed again", () => {
  const who = { owner: "Example", repo: "Sample", pr: 7 };
  assert.notEqual(reviewKey(who, "a".repeat(40)), reviewKey(who, "b".repeat(40)));
});

test("keepReview keeps an approval and a skip, and never an error or a BLOCK, so a re-run asks again", () => {
  const reviewed = (verdict: "APPROVE" | "CHANGES" | "BLOCK") => ({
    status: "reviewed" as const,
    verdict,
    summary: "s",
    findings: [],
    model: "m",
    head_sha: "a".repeat(40),
  });
  assert.equal(keepReview(reviewed("APPROVE")), true);
  assert.equal(keepReview(reviewed("CHANGES")), true);
  assert.equal(
    keepReview({ status: "skipped", reasons: ["docs"], head_sha: "a".repeat(40) }),
    true,
  );
  assert.equal(keepReview({ status: "error", error: "no AI", head_sha: "a".repeat(40) }), false);
  assert.equal(
    keepReview(reviewed("BLOCK")),
    false,
    "a cached BLOCK would hold the pull request after a fix",
  );
});
