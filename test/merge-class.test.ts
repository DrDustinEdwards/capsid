import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MERGE_REQUIRED_CI, evaluatePolicy, type PrFacts } from "../src/auto-merge-policy.ts";
import { mergeClass, pathClassOf, pathClassOfAll } from "../src/merge-class.ts";

// The merge classes (docs/design/design-merge-pipeline.md section 2, the design's PR 2),
// report-only. Each class from one field changed on a PR that would otherwise auto-merge,
// as test/auto-merge.test.ts does for the policy's checks.

const ALLOWED_AUTHORS = ["DrDustinEdwards", "capsid-repo-access[bot]"];

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 23,
    repo: "example-org/sample",
    namespace: "capsid",
    baseRef: "master",
    defaultBranch: "master",
    headSha: "bfae8ca9012345678901234567890123456789ab",
    body: "Closes job_4c0ecc28548b.",
    changedPaths: ["docs/schema.md"],
    filesProblem: null,
    ciConclusion: "success",
    ciNote: "3 check(s) green",
    ciSteps: AUTO_MERGE_REQUIRED_CI.capsid.map((r) => ({ ...r, conclusion: "success" })),
    ciStepsProblem: null,
    headRepo: "example-org/sample",
    prAuthor: "DrDustinEdwards",
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    jobStatus: "done",
    driverAgent: { name: "capsid-driver", kind: "driver", revoked: false },
    jobPrUrls: ["https://github.com/example-org/sample/pull/23"],
    ...over,
  };
}
const classOf = (facts: PrFacts, draft = false) => mergeClass(facts, evaluatePolicy(facts, ALLOWED_AUTHORS), draft);

test("each file's path class, and a PR's is its riskiest file's", () => {
  const cases: Array<[string, string]> = [
    ["docs/schema.md", "docs"],
    ["dashboard/src/styles.css", "dashboard-css"],
    ["dashboard/src/views/Queue.tsx", "dashboard-code"],
    ["test/inbox.test.ts", "tests"],
    ["package-lock.json", "deps-other"],
    ["src/inbox.ts", "src-routine"],
    ["src/store-guards.ts", "src-worth"],
    ["src/auto-merge-tick.ts", "src-worth"],
    [".github/workflows/ci.yml", "workflow"],
    ["migrations/0036_shared_packages.sql", "migration"],
    ["src/billing/invoice.ts", "money"],
  ];
  for (const [path, expected] of cases) assert.equal(pathClassOf(path), expected, path);
  assert.equal(pathClassOfAll(["docs/a.md", "src/inbox.ts", "test/x.test.ts"]), "src-routine");
  assert.equal(pathClassOfAll([]), null);
});

test("a PR that passes the policy is auto", () => {
  assert.deepEqual(classOf(pr()).class, "auto");
});

test("PLANT: a money file in a docs PR is typed, even when everything else would merge", () => {
  const c = classOf(pr({ changedPaths: ["docs/schema.md", "docs/pricing/plans.md"] }));
  assert.equal(c.class, "typed");
  assert.equal(c.path_class, "money");
  // Money outranks the draft and the CI state: nothing moves it out of typed.
  assert.equal(classOf(pr({ changedPaths: ["src/stripe.ts"], ciConclusion: "pending" }), true).class, "typed");
});

test("PLANT: a migration, a workflow, a fork head, another base or an unread file list is seat", () => {
  assert.equal(classOf(pr({ changedPaths: ["migrations/0036_x.sql"] })).class, "seat");
  assert.equal(classOf(pr({ changedPaths: [".github/workflows/ci.yml"] })).class, "seat");
  assert.equal(classOf(pr({ headRepo: "someone/fork" })).class, "seat");
  assert.equal(classOf(pr({ headRepo: null })).class, "seat");
  assert.equal(classOf(pr({ baseRef: "feature" })).class, "seat");
  const unread = classOf(pr({ filesProblem: "more than 3000 files" }));
  assert.equal(unread.class, "seat");
  assert.equal(unread.path_class, null);
});

test("CI not finished, or a draft, is wait", () => {
  assert.equal(classOf(pr({ ciConclusion: "pending", ciNote: "1 check(s) still running: checks" })).class, "wait");
  assert.equal(classOf(pr({ ciConclusion: null, ciNote: "no check run has reported" })).class, "wait");
  assert.equal(classOf(pr(), true).class, "wait");
});

test("a PR stopped only by a rule a person may waive is approve, with the rule as its reason", () => {
  const src = classOf(pr({ changedPaths: ["src/inbox.ts"] }));
  assert.equal(src.class, "approve");
  assert.match(src.reasons[0], /paths_allowed_for_namespace/);
  const red = classOf(pr({ changedPaths: ["src/inbox.ts"], ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(red.class, "approve");
  assert.ok(red.reasons.some((r) => /approval waits for green/.test(r)));
});
