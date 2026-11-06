import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MERGE_REQUIRED_CI, evaluatePolicy, type PrFacts } from "../src/auto-merge-policy.ts";
import { existingTestEdits, type PrFileRow } from "../src/github/pr-files.ts";
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
    changedLines: 40,
    existingTestEdits: [],
    ciConclusion: "success",
    ciNote: "3 check(s) green",
    ciSteps: AUTO_MERGE_REQUIRED_CI.capsid.map((r) => ({ ...r, conclusion: "success" })),
    ciStepsProblem: null,
    headRepo: "example-org/sample",
    prAuthor: "DrDustinEdwards",
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    jobStatus: "done",
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

test("a PR over the size cap is approve, with the reason 'over the size cap', whatever else it fails", () => {
  const big = classOf(pr({ changedLines: 1001 }));
  assert.equal(big.class, "approve");
  assert.deepEqual(big.reasons, ["over the size cap: 1001 changed lines, more than 1000"]);
  // Red CI as well: the size reason leads, and the approval still waits for green.
  const red = classOf(pr({ changedLines: 5000, ciConclusion: "failure", ciNote: "test=failure" }));
  assert.equal(red.class, "approve");
  assert.equal(red.reasons[0], "over the size cap: 5000 changed lines, more than 1000");
  assert.match(red.reasons.join(" "), /CI is failure: an approval waits for green/);
  // Money and the seat still outrank it.
  assert.equal(classOf(pr({ changedLines: 5000, changedPaths: ["src/stripe.ts"] })).class, "typed");
  assert.equal(classOf(pr({ changedLines: 5000, changedPaths: ["migrations/0041_x.sql"] })).class, "seat");
  assert.equal(classOf(pr({ changedLines: 1000 })).class, "auto");
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

// An existing test, changed, always waits for Dustin (src/github/pr-files.ts,
// existingTestEdits), whatever the policy says and whichever units are promoted.

const file = (over: Partial<PrFileRow>): PrFileRow => ({ filename: "test/a.test.ts", status: "modified", additions: 3, deletions: 0, ...over });

test("existingTestEdits: a file added whole, or modified with only added lines, is not an edit", () => {
  assert.deepEqual(existingTestEdits([file({ status: "added" }), file({ filename: "test-integration/b.test.ts", status: "added", deletions: 0 })]), []);
  assert.deepEqual(existingTestEdits([file({ status: "modified", deletions: 0 })]), []);
  assert.deepEqual(existingTestEdits([file({ filename: "src/a.ts", status: "modified", deletions: 9 }), file({ filename: "docs/a.md", status: "removed" })]), [], "a file outside the test directories counted");
});

test("PLANT: existingTestEdits names a one-line edit, a deleted test and a renamed test, in the three test directories", () => {
  assert.deepEqual(existingTestEdits([file({ deletions: 1 })]), ["test/a.test.ts"]);
  assert.deepEqual(existingTestEdits([file({ filename: "test-integration/x.test.ts", status: "removed", additions: 0, deletions: 40 })]), ["test-integration/x.test.ts"]);
  assert.deepEqual(existingTestEdits([file({ filename: "dashboard/e2e/y.spec.ts", status: "renamed", previous_filename: "dashboard/e2e/old.spec.ts", additions: 0 })]), ["dashboard/e2e/old.spec.ts"]);
  // Moved out of the test directory: the old path is deleted all the same.
  assert.deepEqual(existingTestEdits([file({ filename: "scripts/t.mjs", status: "renamed", previous_filename: "test/t.mjs", deletions: 0 })]), ["test/t.mjs"]);
});

test("existingTestEdits covers every path merge-class calls a test: tests/, __tests__/, *.test.* and *.spec.*", () => {
  assert.deepEqual(existingTestEdits([file({ filename: "src/foo.test.ts", deletions: 1 })]), ["src/foo.test.ts"]);
  assert.deepEqual(existingTestEdits([file({ filename: "lib/__tests__/a.ts", deletions: 1 }), file({ filename: "tests/b.ts", status: "removed" }), file({ filename: "web/c.spec.tsx", status: "removed" })]), ["lib/__tests__/a.ts", "tests/b.ts", "web/c.spec.tsx"]);
  assert.deepEqual(existingTestEdits([file({ filename: "src/foo.test.ts", status: "added", deletions: 0 })]), []);
});

test("existingTestEdits fails closed: a test file with no status or no integer deletions is an edit", () => {
  assert.deepEqual(existingTestEdits([{ filename: "test/a.test.ts", additions: 1, deletions: 0 }]), ["test/a.test.ts"]);
  assert.deepEqual(existingTestEdits([{ filename: "test/a.test.ts", status: "modified", additions: 1 }]), ["test/a.test.ts"]);
  assert.deepEqual(existingTestEdits([file({ status: "changed" })]), ["test/a.test.ts"]);
});

test("PLANT: a PR the policy would merge that changes an existing test is class approve, naming the tests first", () => {
  const edits = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
  const facts = pr({ existingTestEdits: edits });
  const verdict = evaluatePolicy(facts, ALLOWED_AUTHORS);
  assert.equal(verdict.merge, true, "the fixture should pass the policy");
  const c = mergeClass(facts, verdict);
  assert.equal(c.class, "approve");
  assert.match(c.reasons[0]!, /^changes an existing test: test\/a\.test\.ts, test\/b\.test\.ts, test\/c\.test\.ts, and 1 more$/);
  assert.equal(c.path_class, "docs");
});

test("a policy refusal on a PR that changes an existing test is approve with the test reason first; money, a draft and unfinished CI still outrank it", () => {
  const edits = ["test/a.test.ts"];
  const refused = classOf(pr({ existingTestEdits: edits, changedLines: 5000 }));
  assert.equal(refused.class, "approve");
  assert.match(refused.reasons[0]!, /^changes an existing test: test\/a\.test\.ts$/);
  assert.ok(refused.reasons.length > 1);
  assert.equal(classOf(pr({ existingTestEdits: edits, changedPaths: ["src/stripe.ts"] })).class, "typed");
  assert.equal(classOf(pr({ existingTestEdits: edits }), true).class, "wait");
  assert.equal(classOf(pr({ existingTestEdits: edits, ciConclusion: "pending" })).class, "wait");
  assert.equal(classOf(pr({ existingTestEdits: edits, changedPaths: ["migrations/0041_x.sql"] })).class, "seat");
});
