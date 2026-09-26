import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTO_MERGE_POLICY_PATH,
  AUTO_MERGE_REFUSED_PATHS,
  AUTO_MERGE_REQUIRED_CI,
  POLICY_CHECKS,
  ciVerdict,
  evaluatePolicy,
  jobIdFromBody,
  loadMergePolicy,
  parseMergePolicy,
  namespacedCiLabels,
  requiredCiFor,
  requiredCiLabel,
  type PrFacts,
} from "../src/auto-merge-policy.ts";
import { AWAITING_SEAT_KEY, FILES_LIMIT, autoMergeTick, declineParams, mergeParams } from "../src/auto-merge-tick.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The Worker may merge a pull request with no human when every check in
// capsid/policy/auto-merge.md passes. These tests drive each check to its refusal on
// its own, because a check only ever seen passing together with the others is unverified.

const SECRET = "test-improve-secret";

// The required steps are per namespace. Every fixture below is a capsid pull request.
const CAPSID_CI = AUTO_MERGE_REQUIRED_CI.capsid;

// The PR author allowlist lives only in the signed document and reaches evaluatePolicy
// from the loaded policy. These are the two allowed logins, as GitHub reports them.
const ALLOWED_AUTHORS = ["DrDustinEdwards", "capsid-repo-access[bot]"];
const evaluate = (facts: PrFacts) => evaluatePolicy(facts, ALLOWED_AUTHORS);

// A PR that passes every check. Each test below breaks exactly one field of it, so a
// refusal can only come from the check that field feeds.
function greenPr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 23,
    repo: "DrDustinEdwards/capsid-mcp",
    namespace: "capsid",
    baseRef: "master",
    defaultBranch: "master",
    headSha: "bfae8ca9012345678901234567890123456789ab",
    body: "Closes job_4c0ecc28548b.\n\nRefuse a swallowed parameter tag.",
    changedPaths: ["src/limits.ts", "docs/schema.md"],
    filesProblem: null,
    ciConclusion: "success",
    ciNote: "3 check(s) green",
    ciSteps: CAPSID_CI.map((r) => ({ ...r, conclusion: "success" })),
    ciStepsProblem: null,
    headRepo: "DrDustinEdwards/capsid-mcp",
    prAuthor: "DrDustinEdwards",
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    jobStatus: "done",
    driverAgent: { name: "capsid-driver", kind: "driver", revoked: false },
    jobPrUrls: ["https://github.com/DrDustinEdwards/capsid-mcp/pull/23"],
    ...over,
  };
}

// the baseline, which every plant below is measured against

test("the unmodified green PR merges, and passes every check the code enforces", () => {
  const verdict = evaluate(greenPr());
  assert.equal(verdict.merge, true);
  assert.deepEqual(
    verdict.merge ? [...verdict.passed].sort() : [],
    [...POLICY_CHECKS].sort(),
    "the merging path must report every check as passed, or the audit row understates what was verified"
  );
});

// each check, refused on its own

test("body_names_job: a PR body with no job id never merges", () => {
  const verdict = evaluate(greenPr({ body: "a tidy little change", jobId: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "body_names_job");
});

test("author_is_driver: a job nobody claimed never merges", () => {
  const verdict = evaluate(greenPr({ jobClaimedBy: null, driverAgent: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
});

test("author_is_driver: a PR from a non-driver author never merges", () => {
  // The seat is a real minted agent and still not a driver. This is the check that
  // stops a human's own PR being merged by the Worker on the seat's credential.
  const verdict = evaluate(
    greenPr({ jobClaimedBy: "agent:seat", driverAgent: { name: "seat", kind: "seat", revoked: false } })
  );
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
  assert.match(verdict.merge === false ? verdict.why : "", /kind 'seat', not a driver/);
});

test("author_is_driver: a revoked driver's open work waits for the seat", () => {
  const verdict = evaluate(
    greenPr({ driverAgent: { name: "capsid-driver", kind: "driver", revoked: true } })
  );
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
  assert.match(verdict.merge === false ? verdict.why : "", /revoked/);
});

test("author_is_driver: a claim by an opkey rather than an agent never merges", () => {
  const verdict = evaluate(greenPr({ jobClaimedBy: "opkey:9f2c1a", driverAgent: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
});

// the PR itself, not only the job it names

test("head_in_base_repo: a fork's PR never merges, nor one whose fork GitHub no longer reports", () => {
  for (const headRepo of ["someone-else/capsid-mcp", null]) {
    const verdict = evaluate(greenPr({ headRepo }));
    assert.equal(verdict.merge, false, `head on ${headRepo} merged`);
    assert.equal(verdict.merge === false && verdict.failed, "head_in_base_repo");
  }
  // Owner and repo names are case-insensitive on GitHub.
  assert.equal(evaluate(greenPr({ headRepo: "drdustinedwards/Capsid-MCP" })).merge, true);
});

test("job_handed_on: a job that has not handed a PR on never merges", () => {
  for (const jobStatus of ["queued", "claimed", "failed", "superseded", null]) {
    const verdict = evaluate(greenPr({ jobStatus }));
    assert.equal(verdict.merge, false, `a ${jobStatus} job's PR merged`);
    assert.equal(verdict.merge === false && verdict.failed, "job_handed_on");
  }
  assert.equal(evaluate(greenPr({ jobStatus: "blocked" })).merge, true, "a blocked job that recorded its PR is handed on");
});

test("pr_recorded_for_job: a PR the job's holder never recorded never merges", () => {
  const cases: Array<[string, string[]]> = [
    ["no record at all", []],
    ["another PR in the same repo", ["https://github.com/DrDustinEdwards/capsid-mcp/pull/22"]],
    ["a PR number that only starts the same", ["https://github.com/DrDustinEdwards/capsid-mcp/pull/234"]],
    ["the same number in another repo", ["https://github.com/DrDustinEdwards/foxhound/pull/23"]],
    ["a document key", ["capsid/notes/done.md"]],
  ];
  for (const [label, jobPrUrls] of cases) {
    const verdict = evaluate(greenPr({ jobPrUrls }));
    assert.equal(verdict.merge, false, `${label}: merged`);
    assert.equal(verdict.merge === false && verdict.failed, "pr_recorded_for_job", label);
  }
  // The same URL in another case, or with a trailing slash, is still this PR.
  assert.equal(evaluate(greenPr({ jobPrUrls: ["https://github.com/drdustinedwards/capsid-mcp/pull/23/"] })).merge, true);
});

// who opened the PR

test("pr_author_allowed: a PR opened by an account not on the allowlist never merges", () => {
  for (const prAuthor of ["someone-else", "dependabot[bot]", "capsid-repo-access", null]) {
    const verdict = evaluate(greenPr({ prAuthor }));
    assert.equal(verdict.merge, false, `a PR by ${prAuthor} merged`);
    assert.equal(verdict.merge === false && verdict.failed, "pr_author_allowed", `${prAuthor}`);
  }
  // An empty allowlist refuses every author, so a caller that lost the list is closed.
  const none = evaluatePolicy(greenPr(), []);
  assert.equal(none.merge === false && none.failed, "pr_author_allowed");
});

test("pr_author_allowed: each allowlisted author proceeds, in any letter case", () => {
  for (const prAuthor of ["DrDustinEdwards", "capsid-repo-access[bot]", "drdustinedwards"]) {
    const verdict = evaluate(greenPr({ prAuthor }));
    assert.equal(verdict.merge, true, `${prAuthor}: ${verdict.merge ? "" : verdict.why}`);
  }
});

test("pr_author_allowed sits with author_is_driver, after the job is named", () => {
  const at = POLICY_CHECKS.indexOf("pr_author_allowed");
  assert.equal(POLICY_CHECKS[at - 1], "body_names_job");
  assert.equal(POLICY_CHECKS[at + 1], "author_is_driver");
});

test("paths_not_refused: src/jobs.ts and src/outcome-prs.ts refuse, since they write what pr_recorded_for_job reads", () => {
  for (const path of ["src/jobs.ts", "src/outcome-prs.ts"]) {
    const verdict = evaluate(greenPr({ changedPaths: ["docs/schema.md", path] }));
    assert.equal(verdict.merge, false, `${path} merged`);
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", path);
  }
});

test("paths_not_refused: the job modules src/jobs.ts re-exports refuse like src/jobs.ts", () => {
  const modules = ["claim", "holder", "seat", "mirror", "transition"].map((part) => `src/jobs-${part}.ts`);
  for (const path of modules) {
    assert.ok(existsSync(join(import.meta.dirname, "..", path)), `${path} does not exist; the refused pattern names a module that is gone`);
    const verdict = evaluate(greenPr({ changedPaths: ["docs/schema.md", path] }));
    assert.equal(verdict.merge, false, `${path} merged`);
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", path);
  }
  assert.equal(modules.length, 5);
});

test("ci_green: the capsid run must show the one merged typecheck step, not the four it replaced", () => {
  const merged = "Typecheck src, tests, integration tests and the copied scorer script";
  assert.deepEqual(
    CAPSID_CI.map((r) => r.step),
    [merged, "Tests", "Integration tests"]
  );
  // A run carrying the four old step names and not the merged one did not run the
  // required step.
  const old = ["Typecheck", "Typecheck tests", "Typecheck integration tests", "Typecheck the copied scorer script", "Tests", "Integration tests"];
  const verdict = evaluate(greenPr({ ciSteps: old.map((step) => ({ workflow: ".github/workflows/ci.yml", job: "checks", step, conclusion: "success" })) }));
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
  assert.match(verdict.merge === false ? verdict.why : "", new RegExp(`checks / ${merged}`));
});

test("the merged typecheck step in ci.yml runs all four configs", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const step = /- name: Typecheck src, tests, integration tests and the copied scorer script\n([\s\S]*?)\n\n/.exec(workflow);
  assert.ok(step, "ci.yml has no merged typecheck step");
  for (const script of ["check", "check:test", "check:integration", "check:scripts"]) {
    assert.match(step[1], new RegExp(`npm run ${script}( |\\|)`), `the merged step does not run ${script}`);
  }
  // No separate typecheck step is left beside it.
  assert.equal([...workflow.matchAll(/- name: Typecheck/g)].length, 1);
});

test("base_is_default_branch: a PR onto a side branch never merges", () => {
  const verdict = evaluate(greenPr({ baseRef: "release/2026-09" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "base_is_default_branch");
});

test("ci_green: a failing head sha never merges", () => {
  const verdict = evaluate(greenPr({ ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
});

test("ci_green: a PR nothing has reported on never merges", () => {
  const verdict = evaluate(greenPr({ ciConclusion: null, ciNote: "no check run has reported on this commit" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
});

test("paths_not_refused: tests, src/, docs, CLAUDE.md and .claude/ merge on green", () => {
  for (const changedPaths of [
    ["src/limits.ts", "test/jobs.test.ts"],
    ["CLAUDE.md"],
    [".claude/commands/improve.md"],
    ["test-integration/jobs.test.ts", "docs/autonomy.md"],
  ]) {
    const verdict = evaluate(greenPr({ changedPaths }));
    assert.equal(verdict.merge, true, `${changedPaths.join(", ")}: ${verdict.merge ? "" : verdict.why}`);
  }
});

test("paths_not_refused: every path the ruling names refuses on its own", () => {
  const named = [
    ".github/workflows/improve-score.yml",
    "scripts/improve-report.mjs",
    "scripts/sync-scorer.mjs",
    "improve/holdout/capsid/imports.txt",
    "src/gate-policy.ts",
    "src/auto-merge.ts",
    "src/policy-sign.ts",
    "src/improve-schema.ts",
    "migrations/0016_next.sql",
    "wrangler.jsonc",
    "wrangler.jsonc.example",
    ".dev.vars",
    ".env",
    ".env.production",
  ];
  for (const path of named) {
    const verdict = evaluate(greenPr({ changedPaths: ["src/limits.ts", path] }));
    assert.equal(verdict.merge, false, `${path} must not merge`);
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", `${path}`);
    assert.match(verdict.merge === false ? verdict.why : "", new RegExp(path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  }
});

test("paths_not_refused: the two auto-merge modules refuse like the file they were split from", () => {
  const modules = ["src/auto-merge-policy.ts", "src/auto-merge-tick.ts"];
  for (const path of modules) {
    assert.ok(existsSync(join(import.meta.dirname, "..", path)), `${path} does not exist; the refused pattern names a module that is gone`);
    const verdict = evaluate(greenPr({ changedPaths: ["docs/schema.md", path] }));
    assert.equal(verdict.merge, false, `${path} merged`);
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", path);
  }
  assert.equal(modules.length, 2);
});

test("paths_not_refused: every pattern in the list matches at least one path above or below", () => {
  // A pattern nothing matches is a refusal nobody has observed. Count stated: the
  // list has 33 entries today, and each must be exercised.
  const samples = [
    ".github/workflows/improve-score.yml", "scripts/improve-report.mjs", "scripts/sync-scorer.mjs",
    "improve/holdout/capsid/imports.txt", "src/improve-scorer.ts", "test/improve-holdout.test.ts",
    "src/gate-policy.ts", "src/auto-merge.ts", "src/policy-sign.ts", "src/improve-schema.ts",
    "src/scope.ts", "src/improve-task.ts", "src/auth.ts", "src/encoding.ts", "src/github/client.ts",
    "scripts/path-guard.mjs", "migrations/0016_next.sql", "wrangler.jsonc", ".dev.vars", ".env",
    "package.json", "tsconfig.test.json", "vitest.config.ts", "scripts/test-budget.mjs", "scripts/verify-live.mjs",
    // dustinedwards-info's judge files, on the same list.
    ".github/workflows/ci.yml", "scripts/check-all.mjs", "scripts/lib/slop.mjs", ".aislop/allow.txt",
    "workers/og/index.ts", "package-lock.json",
    // The writers of the records pr_recorded_for_job reads.
    "src/jobs.ts", "src/outcome-prs.ts",
  ];
  for (const { pattern } of AUTO_MERGE_REFUSED_PATHS) {
    assert.ok(samples.some((s) => pattern.test(s)), `${pattern.source} matches no sample`);
  }
  for (const path of samples) {
    const verdict = evaluate(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", path);
  }
});

// The files that hold each check's answer must refuse too, or a green driver PR could
// weaken the source, merge on its own, and let the next PR pass the weakened check.
test("paths_not_refused: the sources the checks read their answers from refuse on their own", () => {
  const sources = [
    ["src/scope.ts", "isMoneyPath, the whole of paths_not_money"],
    ["src/improve-task.ts", "verifySignedBody, how loadMergePolicy decides the policy is signed"],
    ["src/auth.ts", "the HMAC and the constant-time comparison the verifier delegates to"],
    ["src/encoding.ts", "the hex encoding of the signature the verifier compares"],
    ["src/github/client.ts", "the reader that supplies the changed paths and the CI facts"],
  ];
  for (const [path, what] of sources) {
    const verdict = evaluate(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge, false, `${path} (${what}) must not merge`);
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", path);
    // Alongside an innocent path, so the refusal is the path and not the count.
    const mixed = evaluate(greenPr({ changedPaths: ["src/limits.ts", path] }));
    assert.equal(mixed.merge === false && mixed.failed, "paths_not_refused", `${path} beside src/limits.ts`);
  }
});

test("paths_not_refused: similar-looking paths that are ordinary code are not refused", () => {
  for (const path of [
    "src/improve/tick.ts", "docs/policy/auto-merge.md", "test/auto-merge.test.ts",
    "scripts/mint-agents.mjs", "src/environment.ts",
    // Near-misses of the refused patterns, each a real file this repo carries.
    "src/github/refs.ts", "src/improve-state.ts", "src/jobs-schema.ts", "src/agents-schema.ts", "src/limits.ts",
    "test/jobs.test.ts",
  ]) {
    const verdict = evaluate(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge, true, `${path}: ${verdict.merge ? "" : verdict.why}`);
  }
});

test("paths_not_refused: an incomplete file list is refused before any path is judged", () => {
  const verdict = evaluate(greenPr({ filesProblem: "page 2 returned 502" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused");
  assert.deepEqual(verdict.merge === false ? verdict.passed : null, []);
});

test("paths_not_money: a billing surface never merges", () => {
  // Not on the protected list, so this check is the only thing refusing it. A path
  // that both lists cover would not prove this check runs at all.
  const verdict = evaluate(greenPr({ changedPaths: ["src/billing/invoice.ts"] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_not_money");
});

test("no_migration_workflow_lockfile: a workflow and a lockfile refuse on their own", () => {
  // The only lockfile refused by this check alone. Workflows and package-lock.json are
  // also on the refused list, which runs first, so those are asserted below.
  const verdict = evaluate(greenPr({ changedPaths: ["pnpm-lock.yaml"] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "no_migration_workflow_lockfile");

  // On both lists, and the refused list sees them first. Each stays refused if the
  // other check is the one that changes, which is why the overlap is deliberate.
  for (const path of ["migrations/0012_skills.sql", ".github/workflows/ci.yml", "package-lock.json"]) {
    const both = evaluate(greenPr({ changedPaths: [path] }));
    assert.equal(both.merge === false && both.failed, "paths_not_refused", path);
  }
});

test("ci_green: a run that lacks the integration suite never merges", () => {
  const ciSteps = CAPSID_CI.filter((r) => r.step !== "Integration tests").map((r) => ({ ...r, conclusion: "success" }));
  const verdict = evaluate(greenPr({ ciSteps }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
  assert.match(verdict.merge === false ? verdict.why : "", /checks \/ Integration tests/);
});

test("ci_green: each required step, skipped or missing, refuses on its own", () => {
  assert.ok(CAPSID_CI.length > 0, "capsid names no required CI step");
  for (const required of CAPSID_CI) {
    for (const conclusion of ["skipped", "failure", null, "absent"]) {
      const ciSteps = CAPSID_CI.flatMap((r) =>
        r !== required ? [{ ...r, conclusion: "success" }] : conclusion === "absent" ? [] : [{ ...r, conclusion }]
      );
      const verdict = evaluate(greenPr({ ciSteps }));
      assert.equal(verdict.merge === false && verdict.failed, "ci_green", `${required.step} ${conclusion}`);
      assert.ok(verdict.merge === false && verdict.why.includes(requiredCiLabel(required)), `${required.step} ${conclusion}`);
    }
  }
});

test("ci_green: a same-named step in another job or workflow does not count", () => {
  const ciSteps = CAPSID_CI.map((r) =>
    r.step === "Tests" ? { ...r, job: "score", conclusion: "success" } : { ...r, conclusion: "success" }
  );
  assert.equal(evaluate(greenPr({ ciSteps })).merge, false);
  const other = CAPSID_CI.map((r) =>
    r.step === "Tests" ? { ...r, workflow: ".github/workflows/improve-score.yml", conclusion: "success" } : { ...r, conclusion: "success" }
  );
  assert.equal(evaluate(greenPr({ ciSteps: other })).merge, false);
});

// the required steps are the namespace's, not the policy's

test("requiredCiFor answers per namespace, and a namespace nobody wrote down gets null", () => {
  assert.equal(requiredCiFor("foxhound"), null, "a roster namespace with no steps written down");
  assert.equal(requiredCiFor("nonesuch"), null);
});

test("ci_green: a namespace with no required steps refuses instead of passing on an empty list", () => {
  // An empty required list makes `notRun` empty, so ci_green would pass any run that
  // reported at all.
  const verdict = evaluate(greenPr({ namespace: "foxhound", ciSteps: [] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
  assert.match(verdict.merge === false ? verdict.why : "", /no required CI steps are written down/);
});

test("ci_green: one namespace's green steps do not satisfy another's", () => {
  const asDustinedwards = AUTO_MERGE_REQUIRED_CI.dustinedwards.map((r) => ({ ...r, conclusion: "success" }));
  // capsid's PR, dustinedwards' steps all green: the job name differs, so none of
  // capsid's three are shown to have run.
  const wrong = evaluate(greenPr({ ciSteps: asDustinedwards }));
  assert.equal(wrong.merge, false);
  assert.equal(wrong.merge === false && wrong.failed, "ci_green");
  assert.match(wrong.merge === false ? wrong.why : "", /checks \/ Typecheck/);

  // The same facts under their own namespace merge, so the refusal above is the namespace.
  const right = evaluate(greenPr({ namespace: "dustinedwards", ciSteps: asDustinedwards }));
  assert.equal(right.merge, true, right.merge ? "" : right.why);
});

test("ci_green: steps that could not be read never merge", () => {
  const verdict = evaluate(greenPr({ ciSteps: [], ciStepsProblem: "the workflow run list returned 403" }));
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
  assert.match(verdict.merge === false ? verdict.why : "", /403/);
});

test("a failing check reports only the checks that actually passed before it", () => {
  const verdict = evaluate(greenPr({ ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(verdict.merge, false);
  // ci_green sits last, so exactly the checks before it passed. An audit row that
  // claimed a later check passed would be claiming a check that never ran.
  assert.equal(POLICY_CHECKS[POLICY_CHECKS.length - 1], "ci_green");
  assert.deepEqual(verdict.merge === false ? verdict.passed : [], POLICY_CHECKS.slice(0, -1));
  const early = evaluate(greenPr({ changedPaths: ["src/gate-policy.ts"], ciConclusion: "failure" }));
  assert.deepEqual(early.merge === false ? early.passed : null, [], "the never-list is checked first");
});

// the job id in a PR body

test("jobIdFromBody finds the id in prose and refuses a malformed one", () => {
  assert.equal(jobIdFromBody("Closes job_4c0ecc28548b."), "job_4c0ecc28548b");
  assert.equal(jobIdFromBody("job_4c0ecc28548"), null, "eleven hex digits is not a job id");
  assert.equal(jobIdFromBody("no id here"), null);
  assert.equal(jobIdFromBody(""), null);
});

// CI, where an unreported check is not a pass

test("ciVerdict calls no checks, pending checks and a failure all not-green", () => {
  assert.equal(ciVerdict([]).conclusion, null);
  assert.equal(ciVerdict([{ name: "checks", status: "in_progress", conclusion: null }]).conclusion, "pending");
  assert.equal(ciVerdict([{ name: "checks", status: "completed", conclusion: "failure" }]).conclusion, "failure");
  assert.equal(ciVerdict([{ name: "checks", status: "completed", conclusion: "success" }]).conclusion, "success");
  assert.equal(
    ciVerdict([
      { name: "checks", status: "completed", conclusion: "success" },
      { name: "deploy", status: "completed", conclusion: "failure" },
    ]).conclusion,
    "failure",
    "one red check among green ones is still red"
  );
});

// the policy document

const GOOD_POLICY = [
  "# Auto-merge policy",
  "",
  "- version: 1",
  "- enabled: true",
  "- namespaces: capsid",
  "",
  "## Checks",
  "",
  ...POLICY_CHECKS.map((c) => `- \`${c}\` refuses on its own.`),
  "",
  "## Allowed PR authors",
  "",
  ...ALLOWED_AUTHORS.map((a) => `- author \`${a}\``),
  "",
  "## Refused paths",
  "",
  ...AUTO_MERGE_REFUSED_PATHS.map((p) => `- path \`${p.pattern.source}\` ${p.why}`),
  "",
  // One section per namespace. The document carries every namespace the code holds
  // steps for, because loadMergePolicy compares the two lists in both directions.
  ...Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) => [
    `## Required CI, ${ns}`,
    "",
    ...rows.map((r) => `- step \`${requiredCiLabel(r)}\``),
    "",
  ]),
].join("\n");

test("parseMergePolicy reads the version, the switch and the namespaces", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.version, "1");
  assert.equal(parsed.policy.enabled, true);
  assert.deepEqual(parsed.policy.namespaces, ["capsid"]);
});

test("parseMergePolicy refuses a policy with no version, no switch or no namespace", () => {
  for (const drop of ["- version: 1", "- enabled: true", "- namespaces: capsid"]) {
    const parsed = parseMergePolicy(GOOD_POLICY.replace(`${drop}\n`, ""));
    assert.ok("error" in parsed, `dropping "${drop}" must refuse`);
  }
});

test("parseMergePolicy refuses a namespace that is not on the improve roster", () => {
  const parsed = parseMergePolicy(GOOD_POLICY.replace("- namespaces: capsid", "- namespaces: capsid, julieedwards"));
  assert.ok("error" in parsed);
  assert.match(parsed.error, /julieedwards/);
});

async function envWithPolicy(body: string | null) {
  const { db } = fakeD1({
    documents: body === null ? [] : [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "policy", body }],
  });
  return fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET, APP_KV: fakeKv().kv });
}

test("loadMergePolicy refuses a policy that is absent, unsigned, or edited after signing", async () => {
  assert.match(((await loadMergePolicy(await envWithPolicy(null))) as { error: string }).error, /no merge policy/);

  const unsigned = await loadMergePolicy(await envWithPolicy(GOOD_POLICY));
  assert.ok("error" in unsigned);
  assert.match(unsigned.error, /carries no capsid-task-signature/);

  const signed = await signTaskBody(SECRET, GOOD_POLICY);
  const tampered = signed.replace("- namespaces: capsid", "- namespaces: capsid, foxhound");
  const edited = await loadMergePolicy(await envWithPolicy(tampered));
  assert.ok("error" in edited, "a policy edited after signing must not load");
  assert.match(edited.error, /does not match its body/);
});

test("PLANT: a field added to the frontmatter of a signed policy does not change what loadMergePolicy reads", async () => {
  // The signature covers the body below the frontmatter only, and the parser returns
  // the first `- <name>:` line it sees, so a frontmatter line must not be read.
  const signed = await signTaskBody(SECRET, GOOD_POLICY.replace("- enabled: true", "- enabled: false"));
  const inject = (line: string) => signed.replace(/^---\n/, `---\n${line}\n`);

  for (const plant of ["- enabled: true", "- namespaces: capsid, dustinedwards", "- version: 99"]) {
    const loaded = await loadMergePolicy(await envWithPolicy(inject(plant)));
    if ("policy" in loaded) {
      assert.equal(loaded.policy.enabled, false, `'${plant}' in the frontmatter enabled a policy signed as disabled`);
      assert.deepEqual(loaded.policy.namespaces, ["capsid"], `'${plant}' in the frontmatter widened the signed namespaces`);
      assert.equal(loaded.policy.version, "1", `'${plant}' in the frontmatter replaced the signed version`);
    }
    assert.ok("error" in loaded, `a policy with '${plant}' added to its frontmatter must be refused`);
    assert.match(loaded.error, /besides the capsid-task-signature line/);
  }
});

test("loadMergePolicy accepts the signed policy and refuses one that names fewer checks than the code enforces", async () => {
  const ok = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY)));
  assert.ok("policy" in ok, "the signed policy must load");
  assert.equal(ok.policy.version, "1");

  // The document is what a human reads to know what the machine may do alone, so a
  // code check it does not name is a merge nobody authorised.
  const short = GOOD_POLICY.replace(`- \`ci_green\` refuses on its own.\n`, "");
  const refused = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, short)));
  assert.ok("error" in refused);
  assert.match(refused.error, /does not name ci_green/);
});

test("loadMergePolicy refuses a signed policy whose refused paths or required steps differ from the code, in either direction", async () => {
  const load = async (body: string) => loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, body)));
  const migrations = AUTO_MERGE_REFUSED_PATHS.find((p) => p.pattern.source.includes("migrations"))!;
  const migrationLine = `- path \`${migrations.pattern.source}\` ${migrations.why}\n`;

  // Dropped from the document.
  const dropped = await load(GOOD_POLICY.replace(migrationLine, ""));
  assert.ok("error" in dropped);
  assert.match(dropped.error, /refused paths does not list .*migrations/);

  // Added to the document without code behind it.
  const added = await load(GOOD_POLICY.replace(migrationLine, `${migrationLine}- path \`^docs/\` docs\n`));
  assert.ok("error" in added);
  assert.match(added.error, /lists \^docs\/, which this Worker does not enforce/);

  const noIntegration = await load(GOOD_POLICY.replace("- step `.github/workflows/ci.yml / checks / Integration tests`\n", ""));
  assert.ok("error" in noIntegration);
  assert.match(noIntegration.error, /required CI steps does not list .*Integration tests/);

  const v1 = await load(GOOD_POLICY.split("## Refused paths")[0]);
  assert.ok("error" in v1, "a policy with no refused paths must not load");
});

test("parseMergePolicy files each step under its own namespace heading", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.ok(parsed.policy.requiredCi.includes("capsid / .github/workflows/ci.yml / checks / Tests"));
  assert.ok(parsed.policy.requiredCi.includes("dustinedwards / .github/workflows/ci.yml / Gates, clean checkout / Gates"));
});

test("parseMergePolicy refuses a required step written under no namespace heading", () => {
  const orphan = GOOD_POLICY.replace("## Required CI, capsid", "## Required CI");
  const parsed = parseMergePolicy(orphan);
  assert.ok("error" in parsed, "a step whose repo is unstated must not parse");
  assert.match(parsed.error, /under no namespace heading/);
});

test("parseMergePolicy does not carry a namespace heading past the next heading", () => {
  // A step under `## What a merge means` would otherwise be filed under whichever
  // namespace appeared above it.
  const trailing = `${GOOD_POLICY}\n## What a merge means\n\n- step \`.github/workflows/ci.yml / checks / Smuggled\`\n`;
  const parsed = parseMergePolicy(trailing);
  assert.ok("error" in parsed, "a step after an unrelated heading must not parse");
});

test("parseMergePolicy does not read a refused path or a step as a check id", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.deepEqual(parsed.policy.checks, [...POLICY_CHECKS]);
  assert.equal(parsed.policy.refusedPaths.length, AUTO_MERGE_REFUSED_PATHS.length);
  assert.equal(parsed.policy.requiredCi.length, namespacedCiLabels().length);
  assert.deepEqual(parsed.policy.authors, ALLOWED_AUTHORS);
});

// the author allowlist is carried in the signed document

test("parseMergePolicy reads the author allowlist, and refuses a document without one", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.deepEqual(parsed.policy.authors, ALLOWED_AUTHORS);

  // No author lines, and a heading with nothing under it: both fail closed with a reason.
  const noAuthors = GOOD_POLICY.split("\n").filter((l) => !l.startsWith("- author ")).join("\n");
  for (const body of [noAuthors, noAuthors.replace("## Allowed PR authors\n\n", "")]) {
    const refused = parseMergePolicy(body);
    assert.ok("error" in refused, "a policy with no author allowlist must not parse");
    assert.match(refused.error, /no PR author/);
  }
});

test("loadMergePolicy refuses a signed document with no author allowlist", async () => {
  const noAuthors = GOOD_POLICY.split("\n").filter((l) => !l.startsWith("- author ")).join("\n");
  const loaded = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, noAuthors)));
  assert.ok("error" in loaded, "a signed policy with no allowlist loaded");
  assert.match(loaded.error, /no PR author/);
});

// the document that ships

test("the shipped policy document names exactly the checks the code enforces", () => {
  const shipped = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8");
  const parsed = parseMergePolicy(shipped);
  assert.ok("policy" in parsed, `the shipped policy must parse: ${"error" in parsed ? parsed.error : ""}`);
  assert.deepEqual(
    [...parsed.policy.checks].sort(),
    [...POLICY_CHECKS].sort(),
    "the shipped document and the code must name the same checks, in both directions"
  );
  assert.deepEqual(parsed.policy.refusedPaths, AUTO_MERGE_REFUSED_PATHS.map((p) => p.pattern.source));
  assert.deepEqual(parsed.policy.requiredCi, namespacedCiLabels());
  assert.equal(parsed.policy.enabled, true);
  // The two allowed logins, exactly as GitHub reports them, and no others.
  assert.deepEqual(parsed.policy.authors, ["DrDustinEdwards", "capsid-repo-access[bot]"]);
});

test("every required CI step is a step the CI workflow actually has", () => {
  // A required step the workflow does not have refuses every PR, silently, from the
  // day the step is renamed. Checked against the shipped workflow text.
  //
  // Capsid only: this repo does not hold dustinedwards-info's workflow, so nothing here
  // catches a rename of the dustinedwards steps.
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const stepNames = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim());
  assert.match(workflow, /^  checks:\n    name: checks$/m);
  for (const r of CAPSID_CI) {
    assert.equal(r.workflow, ".github/workflows/ci.yml");
    assert.ok(stepNames.includes(r.step), `ci.yml has no step named '${r.step}'`);
  }
});

// the audit rows

test("the decline audit row names the policy version, the PR, the failing check and why", () => {
  const facts = greenPr({ ciConclusion: "failure", ciNote: "checks=failure" });
  const verdict = evaluate(facts);
  assert.equal(verdict.merge, false);
  const row = declineParams("1", facts, verdict as Extract<typeof verdict, { merge: false }>, new Date("2026-09-12T03:00:00Z"));
  assert.deepEqual(row, {
    policy_version: "1",
    repo: "DrDustinEdwards/capsid-mcp",
    pr: 23,
    head_sha: "bfae8ca9012345678901234567890123456789ab",
    failed: "ci_green",
    why: "CI on bfae8ca is failure: checks=failure",
    passed: [
      "paths_not_refused",
      "paths_not_money",
      "no_migration_workflow_lockfile",
      "head_in_base_repo",
      "body_names_job",
      "pr_author_allowed",
      "author_is_driver",
      "job_handed_on",
      "pr_recorded_for_job",
      "base_is_default_branch",
    ],
    at: "2026-09-12T03:00:00.000Z",
  });
});

test("the merge audit row names the policy version, the job, the driver and both shas", () => {
  const facts = greenPr();
  const verdict = evaluate(facts);
  assert.equal(verdict.merge, true);
  const row = mergeParams("1", facts, verdict.merge ? verdict.passed : [], "f852780aabbccddeeff0011223344556677889900", new Date("2026-09-12T03:00:00Z"));
  assert.deepEqual(row, {
    policy_version: "1",
    repo: "DrDustinEdwards/capsid-mcp",
    pr: 23,
    head_sha: "bfae8ca9012345678901234567890123456789ab",
    job: "job_4c0ecc28548b",
    driver: "agent:capsid-driver",
    merge_sha: "f852780aabbccddeeff0011223344556677889900",
    passed: [...POLICY_CHECKS],
    at: "2026-09-12T03:00:00.000Z",
  });
});

// the tick
//
// Every check above drives `evaluatePolicy`, a pure function with hand-built facts.
// `autoMergeTick` is what production calls (src/improve/tick.ts). A tick that skipped
// loadMergePolicy, ignored `enabled: false`, or merged regardless of the verdict would
// leave the tests above green.

const NS_ROW = [{ namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]) }];

async function tickEnv(policyBody: string | null, over: Record<string, unknown> = {}) {
  const { db } = fakeD1({
    namespaces: NS_ROW,
    documents: policyBody === null ? [] : [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "policy", body: policyBody }],
    ...over,
  });
  return fakeEnv({ DB: db, APP_KV: fakeKv({ seedToken: true }).kv, IMPROVE_SCORE_SECRET: SECRET });
}

test("PLANT: a disabled policy makes the tick reach GitHub not once", async () => {
  const env = await tickEnv(await signTaskBody(SECRET, GOOD_POLICY.replace("- enabled: true", "- enabled: false")));
  await withFetch({}, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
    assert.equal(report.ran, false, "a disabled policy ran the tick");
    assert.match(report.note, /disabled/);
    assert.equal(report.outcomes.length, 0);
    // Nothing was even looked at: `enabled` is read before any repo is resolved.
    assert.equal(calls.length, 0, `a disabled policy still called GitHub: ${JSON.stringify(calls)}`);
  });
});

test("PLANT: an unsigned policy makes the tick reach GitHub not once", async () => {
  const env = await tickEnv(GOOD_POLICY);
  await withFetch({}, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
    assert.equal(report.ran, false, "an unsigned policy ran the tick");
    assert.match(report.note, /carries no capsid-task-signature/);
    assert.equal(calls.length, 0, `an unsigned policy still called GitHub: ${JSON.stringify(calls)}`);
  });
});

test("PLANT: no policy document at all makes the tick reach GitHub not once", async () => {
  const env = await tickEnv(null);
  await withFetch({}, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
    assert.equal(report.ran, false);
    assert.match(report.note, /no merge policy/);
    assert.equal(calls.length, 0);
  });
});

// The enabled cases.

const OWNER = "/repos/DrDustinEdwards/capsid";
const HEAD_SHA = "bfae8ca9012345678901234567890123456789ab";

const PR_URL = "https://github.com/DrDustinEdwards/capsid/pull/23";

function tickRoutes(changedFiles: string[], headRepo: string | null = "DrDustinEdwards/capsid", author: string | null = "DrDustinEdwards") {
  return {
    [`GET ${OWNER}`]: { body: { default_branch: "master" } },
    [`GET ${OWNER}/pulls`]: {
      body: [
        {
          number: 23,
          body: "Closes job_4c0ecc28548b.",
          head: { sha: HEAD_SHA, repo: headRepo === null ? null : { full_name: headRepo } },
          base: { ref: "master" },
          user: author === null ? null : { login: author },
        },
      ],
    },
    [`GET ${OWNER}/pulls/23/files`]: { body: changedFiles.map((filename) => ({ filename })) },
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: {
      body: { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] },
    },
    [`PUT ${OWNER}/pulls/23/merge`]: { body: { sha: "merged00000000000000000000000000000000000" } },
    ...ciRunRoutes(CAPSID_CI.map((r) => r.step)),
  };
}

// The Actions runs for the head sha and the jobs of the CI run, as GitHub serves them.
// The CI run carries the named steps; an older CI run and an unrelated workflow's run
// sit beside it so the newest-run and path filters are exercised.
function ciRunRoutes(steps: string[]) {
  return {
    [`GET ${OWNER}/actions/runs`]: (_body: unknown, search: URLSearchParams) => ({
      body: {
        workflow_runs:
          search.get("head_sha") === HEAD_SHA
            ? [
                { id: 900, path: ".github/workflows/ci.yml" },
                { id: 950, path: ".github/workflows/ci.yml" },
                { id: 990, path: ".github/workflows/improve-score.yml" },
              ]
            : [],
      },
    }),
    [`GET ${OWNER}/actions/runs/900/jobs`]: { body: { jobs: [] } },
    [`GET ${OWNER}/actions/runs/950/jobs`]: {
      body: {
        jobs: [
          { name: "checks", steps: [{ name: "Install dependencies", conclusion: "success" }, ...steps.map((name) => ({ name, conclusion: "success" }))] },
          { name: "deploy", steps: [{ name: "Deploy", conclusion: "skipped" }] },
        ],
      },
    },
  };
}

// The job as a driver leaves it: completed, with the PR it opened as its result_ref.
async function enabledEnv(
  claimedBy = "agent:capsid-driver",
  job: { status?: string; result_ref?: string | null } = {},
  jobOutcomePrs: Array<{ job_id: string; pr_url: string }> = []
) {
  return tickEnv(await signTaskBody(SECRET, GOOD_POLICY), {
    jobs: [
      {
        id: "job_4c0ecc28548b",
        namespace: "capsid",
        claimed_by: claimedBy,
        status: job.status ?? "done",
        result_ref: job.result_ref === undefined ? PR_URL : job.result_ref,
      },
    ],
    jobOutcomePrs,
    agents: [
      { name: "capsid-driver", kind: "driver", revoked_at: null },
      { name: "seat", kind: "seat", revoked_at: null },
    ],
  });
}

test("PLANT: an enabled policy merges a green PR, through the tick and not through evaluatePolicy", async () => {
  const env = await enabledEnv();
  await withFetch(tickRoutes(["src/limits.ts", "docs/schema.md"]), async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
    assert.equal(report.ran, true, report.note);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].merged, true, `the green PR was not merged: ${report.outcomes[0].why}`);
    const merges = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"));
    assert.equal(merges.length, 1, "the tick reported a merge it never issued");
  });
});

test("PLANT: an enabled policy DECLINES a protected-path PR and issues no merge", async () => {
  // A tick that called evaluatePolicy and merged anyway would pass the test above and
  // fail here.
  const env = await enabledEnv();
  await withFetch(tickRoutes([".github/workflows/nightly.yml"]), async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
    assert.equal(report.ran, true, report.note);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].merged, false, "a protected-path PR was auto-merged");
    assert.ok(report.outcomes[0].failed, "a decline recorded no failing check");
    const merges = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"));
    assert.equal(merges.length, 0, "a declined PR was merged anyway");
  });
});

// path and CI plants, through the tick
//
// Each runs the real tick against a signed document, so a tick that ignored the
// verdict fails here.

async function tickPlant(files: string[], opts: { claimedBy?: string; steps?: string[] } = {}) {
  const env = await enabledEnv(opts.claimedBy);
  const routes = { ...tickRoutes(files), ...ciRunRoutes(opts.steps ?? CAPSID_CI.map((r) => r.step)) };
  let out: { outcome: Awaited<ReturnType<typeof autoMergeTick>>["outcomes"][number]; merges: number } | null = null;
  await withFetch(routes as never, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-17T14:00:00Z"));
    assert.equal(report.ran, true, report.note);
    assert.equal(report.outcomes.length, 1);
    out = { outcome: report.outcomes[0], merges: calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length };
  });
  return out!;
}

test("PLANT v2: a driver PR touching only test/ and src/ is merged by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/limits.ts", "test/jobs.test.ts"]);
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
  assert.deepEqual(outcome.passed, [...POLICY_CHECKS]);
});

test("PLANT v2: a PR touching src/gate-policy.ts is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/limits.ts", "src/gate-policy.ts"]);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "paths_not_refused");
  assert.match(outcome.why ?? "", /src\/gate-policy\.ts/);
});

test("PLANT v2: a PR touching migrations/ is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/limits.ts", "migrations/0016_outcome_notes.sql"]);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "paths_not_refused");
});

test("PLANT v2: a PR whose CI lacks the integration suite is refused by the tick", async () => {
  const steps = CAPSID_CI.map((r) => r.step).filter((s) => s !== "Integration tests");
  const { outcome, merges } = await tickPlant(["src/limits.ts"], { steps });
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "ci_green");
  assert.match(outcome.why ?? "", /Integration tests/);
});

test("PLANT v2: a PR from the seat's job is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/limits.ts"], { claimedBy: "agent:seat" });
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "author_is_driver");
  assert.match(outcome.why ?? "", /kind 'seat', not a driver/);
});

// the PR itself, through the tick
//
// Each plant below names a finished driver job with green CI and src/-only changes, so
// the refusal can only come from a fact about the PR itself.

async function tickWith(env: Awaited<ReturnType<typeof enabledEnv>>, routes: Record<string, unknown>) {
  let out: { outcome: Awaited<ReturnType<typeof autoMergeTick>>["outcomes"][number]; merges: number } | null = null;
  await withFetch(routes as never, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-25T12:00:00Z"));
    assert.equal(report.ran, true, report.note);
    assert.equal(report.outcomes.length, 1);
    out = { outcome: report.outcomes[0], merges: calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length };
  });
  return out!;
}

test("PLANT v5: a same-repo PR opened by an account off the allowlist is refused by the tick", async () => {
  // Everything else passes: the job is done, recorded this PR, and CI is green.
  const { outcome, merges } = await tickWith(await enabledEnv(), tickRoutes(["src/limits.ts"], "DrDustinEdwards/capsid", "someone-else"));
  assert.equal(merges, 0, "a PR by an account off the allowlist was auto-merged");
  assert.equal(outcome.failed, "pr_author_allowed");
  assert.match(outcome.why ?? "", /someone-else/);
});

test("PLANT v5: a PR GitHub reports no author for is refused by the tick", async () => {
  const { outcome, merges } = await tickWith(await enabledEnv(), tickRoutes(["src/limits.ts"], "DrDustinEdwards/capsid", null));
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "pr_author_allowed");
});

test("PLANT v5: a PR opened by the App's bot account is merged by the tick", async () => {
  const { outcome, merges } = await tickWith(await enabledEnv(), tickRoutes(["src/limits.ts"], "DrDustinEdwards/capsid", "capsid-repo-access[bot]"));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
});

test("PLANT v5: a PR touching src/jobs.ts is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["docs/schema.md", "src/jobs.ts"]);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "paths_not_refused");
  assert.match(outcome.why ?? "", /src\/jobs\.ts/);
});

test("PLANT: a PR that renames a refused file to an ordinary path is refused by the tick", async () => {
  // GitHub lists a rename once, under the new name, with the old one in
  // previous_filename. Both names must be judged.
  const routes = {
    ...tickRoutes([]),
    [`GET ${OWNER}/pulls/23/files`]: {
      body: [
        { filename: "src/limits.ts" },
        { filename: "src/old-merge.ts", previous_filename: "src/auto-merge.ts", status: "renamed" },
      ],
    },
  };
  const { outcome, merges } = await tickWith(await enabledEnv(), routes);
  assert.equal(merges, 0, "a rename out of a refused path was auto-merged");
  assert.equal(outcome.failed, "paths_not_refused");
  assert.match(outcome.why ?? "", /src\/auto-merge\.ts/);
});

test("PLANT: a PR that renames an ordinary file to another ordinary path is still merged by the tick", async () => {
  const routes = {
    ...tickRoutes([]),
    [`GET ${OWNER}/pulls/23/files`]: { body: [{ filename: "docs/new-name.md", previous_filename: "docs/old-name.md", status: "renamed" }] },
  };
  const { outcome, merges } = await tickWith(await enabledEnv(), routes);
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
});

test("PLANT F2-1: a fork PR naming a done driver job is refused by the tick", async () => {
  // The job even records this PR's URL; the head is still on a fork.
  const { outcome, merges } = await tickWith(await enabledEnv(), tickRoutes(["src/limits.ts"], "attacker/capsid"));
  assert.equal(merges, 0, "a fork PR was auto-merged");
  assert.equal(outcome.failed, "head_in_base_repo");
  assert.match(outcome.why ?? "", /attacker\/capsid/);
});

test("PLANT F2-1: a same-repo PR naming a done driver job that never recorded it is refused by the tick", async () => {
  // The driver's job is done and names ANOTHER PR, which is what a finished job whose
  // id somebody copied into their own PR body looks like.
  const env = await enabledEnv("agent:capsid-driver", { result_ref: "https://github.com/DrDustinEdwards/capsid/pull/22" }, [
    { job_id: "job_4c0ecc28548b", pr_url: "https://github.com/DrDustinEdwards/capsid/pull/22" },
  ]);
  const { outcome, merges } = await tickWith(env, tickRoutes(["src/limits.ts"]));
  assert.equal(merges, 0, "a PR the job never recorded was auto-merged");
  assert.equal(outcome.failed, "pr_recorded_for_job");
});

test("PLANT F2-1: a PR naming a driver job still claimed is refused by the tick", async () => {
  const { outcome, merges } = await tickWith(await enabledEnv("agent:capsid-driver", { status: "claimed", result_ref: null }), tickRoutes(["src/limits.ts"]));
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "job_handed_on");
});

test("F2-1: a PR recorded only in job_outcome_prs, from evidence.prs, still merges", async () => {
  const env = await enabledEnv("agent:capsid-driver", { result_ref: "capsid/notes/done.md" }, [{ job_id: "job_4c0ecc28548b", pr_url: PR_URL }]);
  const { outcome, merges } = await tickWith(env, tickRoutes(["src/limits.ts"]));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
  assert.deepEqual(outcome.passed, [...POLICY_CHECKS]);
});

test("the tick refuses when the Actions run list cannot be read", async () => {
  const env = await enabledEnv();
  const routes = { ...tickRoutes(["src/limits.ts"]), [`GET ${OWNER}/actions/runs`]: { status: 403, text: "Resource not accessible by integration" } };
  await withFetch(routes as never, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-17T14:00:00Z"));
    assert.equal(report.outcomes[0].failed, "ci_green");
    assert.match(report.outcomes[0].why ?? "", /403/);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });
});

// the merge is pinned to the head the policy judged
//
// Without `sha` in the merge PUT, a push to the PR head between the reads and the merge
// would be merged unjudged. GitHub answers 409 when the head no longer matches the sha.

async function pinnedEnv() {
  const d1 = fakeD1({
    namespaces: NS_ROW,
    documents: [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "policy", body: await signTaskBody(SECRET, GOOD_POLICY) }],
    jobs: [{ id: "job_4c0ecc28548b", namespace: "capsid", claimed_by: "agent:capsid-driver", status: "done", result_ref: PR_URL }],
    agents: [{ name: "capsid-driver", kind: "driver", revoked_at: null }],
  });
  const kv = fakeKv({ seedToken: true });
  return { d1, kv, env: fakeEnv({ DB: d1.db, APP_KV: kv.kv, IMPROVE_SCORE_SECRET: SECRET }) };
}

test("the merge request carries the head sha the policy evaluated", async () => {
  const { env } = await pinnedEnv();
  await withFetch(tickRoutes(["src/limits.ts"]), async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-25T12:00:00Z"));
    assert.equal(report.outcomes[0].merged, true, report.outcomes[0].why ?? "");
    const merges = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"));
    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0].body, { merge_method: "merge", sha: HEAD_SHA });
  });
});

test("a head that moved before the merge (GitHub 409) is reported not merged, audited, and does not abort the tick", async () => {
  const { d1, kv, env } = await pinnedEnv();
  const routes = {
    ...tickRoutes(["src/limits.ts"]),
    [`PUT ${OWNER}/pulls/23/merge`]: { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } },
  };
  await withFetch(routes as never, async () => {
    const report = await autoMergeTick(env, new Date("2026-09-25T12:00:00Z"));
    assert.equal(report.ran, true, report.note);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].merged, false, "a merge GitHub refused was reported as merged");
    assert.equal(report.outcomes[0].failed, "head_moved");
    assert.match(report.outcomes[0].why ?? "", new RegExp(HEAD_SHA));
  });
  const audits = d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql));
  assert.equal(audits.length, 1, "expected exactly one audit row");
  assert.equal(audits[0].params[1], "auto-merge-declined");
  const params = JSON.parse(String(audits[0].params[4]));
  assert.equal(params.head_sha, HEAD_SHA);
  assert.equal(params.failed, "head_moved");
  const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string);
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0].failed, "head_moved");
});

// paging: every page of files and check runs is read
//
// The routes below answer the way GitHub does: at most `per_page` rows per call, and a
// Link rel="next" header while more remain.

function paged<T>(rows: T[], wrap: (page: T[]) => unknown = (page) => page) {
  return (_body: unknown, search: URLSearchParams) => {
    const perPage = Number(search.get("per_page") ?? 30);
    const page = Number(search.get("page") ?? 1);
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    const more = page * perPage < rows.length;
    return {
      body: wrap(slice),
      ...(more ? { headers: { Link: `<https://api.github.com/repositories/1/x?per_page=${perPage}&page=${page + 1}>; rel="next"` } } : {}),
    };
  };
}

function pagedRoutes(files: string[], runs: Array<{ name: string; status: string; conclusion: string | null }>) {
  return {
    ...tickRoutes([]),
    [`GET ${OWNER}/pulls/23/files`]: paged(files.map((filename) => ({ filename }))),
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: paged(runs, (page) => ({ total_count: runs.length, check_runs: page })),
  };
}

const safeFiles = (n: number) => Array.from({ length: n }, (_, i) => `docs/page-${String(i).padStart(4, "0")}.md`);
const green = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `check-${i}`, status: "completed", conclusion: "success" }));

async function tickOnce(routes: Record<string, unknown>) {
  const env = await enabledEnv();
  let result: { report: Awaited<ReturnType<typeof autoMergeTick>>; merges: number } | null = null;
  await withFetch(routes as never, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-17T12:00:00Z"));
    result = { report, merges: calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length };
  });
  return result!;
}

test("PLANT: a protected path on the SECOND page of files is seen, and the PR is not merged", async () => {
  const { report, merges } = await tickOnce(pagedRoutes([...safeFiles(100), "migrations/0099_planted.sql"], green(1)));
  assert.equal(report.outcomes.length, 1);
  assert.equal(merges, 0, "a PR whose 101st file is a migration was auto-merged");
  assert.equal(report.outcomes[0].merged, false);
  assert.equal(report.outcomes[0].failed, "paths_not_refused", report.outcomes[0].why ?? "");
  assert.match(report.outcomes[0].why ?? "", /migrations\/0099_planted\.sql/);
});

test("PLANT: a failing check on the SECOND page of check runs is seen, and the PR is not merged", async () => {
  const runs = [...green(100), { name: "late-check", status: "completed", conclusion: "failure" }];
  const { report, merges } = await tickOnce(pagedRoutes(safeFiles(2), runs));
  assert.equal(merges, 0, "a PR with a failing 101st check run was auto-merged");
  assert.equal(report.outcomes[0].failed, "ci_green");
  assert.match(report.outcomes[0].why ?? "", /late-check=failure/);
});

test("paging is not a refusal: a green PR spread over several pages still merges", async () => {
  const { report, merges } = await tickOnce(pagedRoutes(safeFiles(250), green(150)));
  assert.equal(report.outcomes[0].merged, true, report.outcomes[0].why ?? "");
  assert.equal(merges, 1);
});

test("a file list GitHub itself truncates is refused, not judged on what came back", async () => {
  // GitHub lists at most 3000 files for a pull request and then stops offering a next
  // page, so a list that reaches the ceiling cannot be told apart from one that was cut.
  const { report, merges } = await tickOnce(pagedRoutes(safeFiles(FILES_LIMIT), green(1)));
  assert.equal(merges, 0);
  assert.equal(report.outcomes[0].merged, false);
  assert.match(report.outcomes[0].why ?? "", new RegExp(`at most ${FILES_LIMIT} files`));
});

test("a page that fails partway is refused, not judged on the pages that loaded", async () => {
  const files = paged(safeFiles(150).map((filename) => ({ filename })));
  const routes = {
    ...pagedRoutes([], green(1)),
    [`GET ${OWNER}/pulls/23/files`]: (body: unknown, search: URLSearchParams) =>
      search.get("page") === "2" ? { status: 502, text: "bad gateway" } : files(body, search),
  };
  const { report, merges } = await tickOnce(routes);
  assert.equal(merges, 0);
  assert.equal(report.outcomes[0].merged, false);
  assert.match(report.outcomes[0].why ?? "", /502/);
});

// one PR cannot end the tick, and a PR naming no job costs no GitHub read

const NO_JOB_SHA = "cccc000000000000000000000000000000000000";

function twoPrRoutes(mergeRoute: unknown) {
  const base = tickRoutes(["src/limits.ts"]);
  return {
    ...base,
    [`GET ${OWNER}/pulls`]: {
      body: [
        ...(base[`GET ${OWNER}/pulls`] as { body: unknown[] }).body,
        { number: 30, body: "A human's change, no job here.", head: { sha: NO_JOB_SHA, repo: { full_name: "DrDustinEdwards/capsid" } }, base: { ref: "master" } },
      ],
    },
    [`PUT ${OWNER}/pulls/23/merge`]: mergeRoute,
  };
}

test("PLANT F3-6: a merge GitHub refuses with 405 is audited as failed, and the tick goes on to the next PR and writes the awaiting set", async () => {
  const { d1, kv, env } = await pinnedEnv();
  let report: Awaited<ReturnType<typeof autoMergeTick>> | null = null;
  await withFetch(twoPrRoutes({ status: 405, body: { message: "Pull Request is not mergeable" } }) as never, async () => {
    report = await autoMergeTick(env, new Date("2026-09-25T12:00:00Z"));
  });
  const out = report!;
  assert.equal(out.ran, true, out.note);
  assert.equal(out.outcomes.length, 2, "the throw on PR 23 stopped the tick before PR 30");
  const first = out.outcomes.find((o) => o.number === 23);
  assert.equal(first?.merged, false);
  assert.equal(first?.failed, "error");
  assert.match(first?.why ?? "", /405/);
  const actions = d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql)).map((r) => r.params[1]);
  assert.ok(actions.includes("auto-merge-failed"), `no failure audit row: ${JSON.stringify(actions)}`);
  const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string) as Array<{ number: number; failed: string }>;
  assert.deepEqual(awaiting.map((a) => [a.number, a.failed]).sort(), [[23, "error"], [30, "body_names_job"]]);
});

test("PLANT F7-1: a PR whose body names no job is declined without reading its files, checks or CI runs", async () => {
  const { d1, env } = await pinnedEnv();
  let calls: Array<{ method: string; path: string; search?: string }> = [];
  let report: Awaited<ReturnType<typeof autoMergeTick>> | null = null;
  await withFetch(twoPrRoutes({ body: { sha: "merged00000000000000000000000000000000000" } }) as never, async (c) => {
    report = await autoMergeTick(env, new Date("2026-09-25T12:00:00Z"));
    calls = c;
  });
  const skipped = report!.outcomes.find((o) => o.number === 30);
  assert.equal(skipped?.merged, false);
  assert.equal(skipped?.failed, "body_names_job");
  const aboutPr30 = calls.filter((c) => c.path.includes("/pulls/30") || c.path.includes(NO_JOB_SHA) || (c.search ?? "").includes(NO_JOB_SHA));
  assert.deepEqual(aboutPr30, [], "the tick read GitHub for a PR that names no job");
  // The PR that names a job is still judged and merged, so the skip is not a wall.
  assert.equal(report!.outcomes.find((o) => o.number === 23)?.merged, true);
  const declined = d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql) && r.params[1] === "auto-merge-declined");
  assert.equal(declined.length, 1);
  assert.equal(JSON.parse(String(declined[0].params[4])).head_sha, NO_JOB_SHA);
});
