import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTO_MERGE_POLICY_PATH,
  AUTO_MERGE_REFUSED_PATHS,
  AUTO_MERGE_REQUIRED_CI,
  FILES_LIMIT,
  POLICY_CHECKS,
  ciVerdict,
  declineParams,
  evaluatePolicy,
  jobIdFromBody,
  loadMergePolicy,
  mergeParams,
  parseMergePolicy,
  autoMergeTick,
  requiredCiLabel,
  type PrFacts,
} from "../src/auto-merge.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// PART 1 OF THE AUTONOMY ARC. The Worker may merge a pull request with no human when
// every check in capsid/policy/auto-merge.md passes. These tests drive each check to
// its refusal on its own, because a policy whose checks have only ever been seen
// passing together is a policy nobody has verified: capsid/conventions.md, "a guard
// that has never been observed failing has not been verified".

const SECRET = "test-improve-secret";

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
    changedPaths: ["src/jobs.ts", "docs/schema.md"],
    filesProblem: null,
    ciConclusion: "success",
    ciNote: "3 check(s) green",
    ciSteps: AUTO_MERGE_REQUIRED_CI.map((r) => ({ ...r, conclusion: "success" })),
    ciStepsProblem: null,
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    driverAgent: { name: "capsid-driver", kind: "driver", revoked: false },
    ...over,
  };
}

// ---- the baseline, which every plant below is measured against ------------------

test("the unmodified green PR merges, and passes every check the code enforces", () => {
  const verdict = evaluatePolicy(greenPr());
  assert.equal(verdict.merge, true);
  assert.deepEqual(
    verdict.merge ? [...verdict.passed].sort() : [],
    [...POLICY_CHECKS].sort(),
    "the merging path must report every check as passed, or the audit row understates what was verified"
  );
});

// ---- each check, refused on its own ---------------------------------------------

test("body_names_job: a PR body with no job id never merges", () => {
  const verdict = evaluatePolicy(greenPr({ body: "a tidy little change", jobId: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "body_names_job");
});

test("author_is_driver: a job nobody claimed never merges", () => {
  const verdict = evaluatePolicy(greenPr({ jobClaimedBy: null, driverAgent: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
});

test("author_is_driver: a PR from a non-driver author never merges", () => {
  // The seat is a real minted agent and still not a driver. This is the check that
  // stops a human's own PR being merged by the Worker on the seat's credential.
  const verdict = evaluatePolicy(
    greenPr({ jobClaimedBy: "agent:seat", driverAgent: { name: "seat", kind: "seat", revoked: false } })
  );
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
  assert.match(verdict.merge === false ? verdict.why : "", /kind 'seat', not a driver/);
});

test("author_is_driver: a revoked driver's open work waits for the seat", () => {
  const verdict = evaluatePolicy(
    greenPr({ driverAgent: { name: "capsid-driver", kind: "driver", revoked: true } })
  );
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
  assert.match(verdict.merge === false ? verdict.why : "", /revoked/);
});

test("author_is_driver: a claim by an opkey rather than an agent never merges", () => {
  const verdict = evaluatePolicy(greenPr({ jobClaimedBy: "opkey:9f2c1a", driverAgent: null }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "author_is_driver");
});

test("base_is_default_branch: a PR onto a side branch never merges", () => {
  const verdict = evaluatePolicy(greenPr({ baseRef: "release/2026-09" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "base_is_default_branch");
});

test("ci_green: a failing head sha never merges", () => {
  const verdict = evaluatePolicy(greenPr({ ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
});

test("ci_green: a PR nothing has reported on never merges", () => {
  const verdict = evaluatePolicy(greenPr({ ciConclusion: null, ciNote: "no check run has reported on this commit" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
});

// Policy version 2 (ruled 2026-09-17): tests, src/, docs, CLAUDE.md and .claude/ merge
// on green. Under version 1 every one of these was left for the seat by
// paths_unprotected, which is what this job existed to change.
test("paths_not_refused: tests, src/, docs, CLAUDE.md and .claude/ merge on green", () => {
  for (const changedPaths of [
    ["src/jobs.ts", "test/jobs.test.ts"],
    ["CLAUDE.md"],
    [".claude/commands/improve.md"],
    ["test-integration/jobs.test.ts", "docs/autonomy.md"],
  ]) {
    const verdict = evaluatePolicy(greenPr({ changedPaths }));
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
    const verdict = evaluatePolicy(greenPr({ changedPaths: ["src/jobs.ts", path] }));
    assert.equal(verdict.merge, false, `${path} must not merge`);
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", `${path}`);
    assert.match(verdict.merge === false ? verdict.why : "", new RegExp(path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  }
});

test("paths_not_refused: every pattern in the list matches at least one path above or below", () => {
  // A pattern nothing matches is a refusal nobody has observed. Count stated: the
  // list has 20 entries today, and each must be exercised.
  const samples = [
    ".github/workflows/improve-score.yml", "scripts/improve-report.mjs", "scripts/sync-scorer.mjs",
    "improve/holdout/capsid/imports.txt", "src/improve-scorer.ts", "test/improve-holdout.test.ts",
    "src/gate-policy.ts", "src/auto-merge.ts", "src/policy-sign.ts", "src/improve-schema.ts",
    "scripts/path-guard.mjs", "migrations/0016_next.sql", "wrangler.jsonc", ".dev.vars", ".env",
    "package.json", "tsconfig.test.json", "vitest.config.ts", "scripts/test-budget.mjs", "scripts/verify-live.mjs",
  ];
  assert.equal(AUTO_MERGE_REFUSED_PATHS.length, 20);
  for (const { pattern } of AUTO_MERGE_REFUSED_PATHS) {
    assert.ok(samples.some((s) => pattern.test(s)), `${pattern.source} matches no sample`);
  }
  for (const path of samples) {
    const verdict = evaluatePolicy(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused", path);
  }
});

test("paths_not_refused: similar-looking paths that are ordinary code are not refused", () => {
  for (const path of ["src/jobs.ts", "src/improve/tick.ts", "docs/policy/auto-merge.md", "test/auto-merge.test.ts", "scripts/mint-agents.mjs", "src/environment.ts"]) {
    const verdict = evaluatePolicy(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge, true, `${path}: ${verdict.merge ? "" : verdict.why}`);
  }
});

test("paths_not_refused: an incomplete file list is refused before any path is judged", () => {
  const verdict = evaluatePolicy(greenPr({ filesProblem: "page 2 returned 502" }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_not_refused");
  assert.deepEqual(verdict.merge === false ? verdict.passed : null, []);
});

test("paths_not_money: a billing surface never merges", () => {
  // Not on the protected list, so this check is the only thing refusing it. A path
  // that both lists cover would not prove this check runs at all.
  const verdict = evaluatePolicy(greenPr({ changedPaths: ["src/billing/invoice.ts"] }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "paths_not_money");
});

test("no_migration_workflow_lockfile: a workflow and a lockfile refuse on their own", () => {
  // Neither is on the refused list, so this check is the only thing refusing them.
  for (const path of [".github/workflows/ci.yml", "package-lock.json", "pnpm-lock.yaml"]) {
    const verdict = evaluatePolicy(greenPr({ changedPaths: [path] }));
    assert.equal(verdict.merge, false, `${path} must not merge`);
    assert.equal(verdict.merge === false && verdict.failed, "no_migration_workflow_lockfile", path);
  }
  // A migration is on both lists, and the refused list sees it first.
  const migration = evaluatePolicy(greenPr({ changedPaths: ["migrations/0012_skills.sql"] }));
  assert.equal(migration.merge === false && migration.failed, "paths_not_refused");
});

test("ci_green: a run that lacks the integration suite never merges", () => {
  const ciSteps = AUTO_MERGE_REQUIRED_CI.filter((r) => r.step !== "Integration tests").map((r) => ({ ...r, conclusion: "success" }));
  const verdict = evaluatePolicy(greenPr({ ciSteps }));
  assert.equal(verdict.merge, false);
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
  assert.match(verdict.merge === false ? verdict.why : "", /checks \/ Integration tests/);
});

test("ci_green: each required step, skipped or missing, refuses on its own", () => {
  assert.equal(AUTO_MERGE_REQUIRED_CI.length, 6, "the unit suite, four typechecks and the integration suite");
  for (const required of AUTO_MERGE_REQUIRED_CI) {
    for (const conclusion of ["skipped", "failure", null, "absent"]) {
      const ciSteps = AUTO_MERGE_REQUIRED_CI.flatMap((r) =>
        r !== required ? [{ ...r, conclusion: "success" }] : conclusion === "absent" ? [] : [{ ...r, conclusion }]
      );
      const verdict = evaluatePolicy(greenPr({ ciSteps }));
      assert.equal(verdict.merge === false && verdict.failed, "ci_green", `${required.step} ${conclusion}`);
      assert.ok(verdict.merge === false && verdict.why.includes(requiredCiLabel(required)), `${required.step} ${conclusion}`);
    }
  }
});

test("ci_green: a same-named step in another job or workflow does not count", () => {
  const ciSteps = AUTO_MERGE_REQUIRED_CI.map((r) =>
    r.step === "Tests" ? { ...r, job: "score", conclusion: "success" } : { ...r, conclusion: "success" }
  );
  assert.equal(evaluatePolicy(greenPr({ ciSteps })).merge, false);
  const other = AUTO_MERGE_REQUIRED_CI.map((r) =>
    r.step === "Tests" ? { ...r, workflow: ".github/workflows/improve-score.yml", conclusion: "success" } : { ...r, conclusion: "success" }
  );
  assert.equal(evaluatePolicy(greenPr({ ciSteps: other })).merge, false);
});

test("ci_green: steps that could not be read never merge", () => {
  const verdict = evaluatePolicy(greenPr({ ciSteps: [], ciStepsProblem: "the workflow run list returned 403" }));
  assert.equal(verdict.merge === false && verdict.failed, "ci_green");
  assert.match(verdict.merge === false ? verdict.why : "", /403/);
});

test("a failing check reports only the checks that actually passed before it", () => {
  const verdict = evaluatePolicy(greenPr({ ciConclusion: "failure", ciNote: "checks=failure" }));
  assert.equal(verdict.merge, false);
  // ci_green sits last, so exactly the six before it passed. An audit row that
  // claimed a later check passed would be claiming a check that never ran.
  assert.deepEqual(verdict.merge === false ? verdict.passed : [], POLICY_CHECKS.slice(0, 6));
  const early = evaluatePolicy(greenPr({ changedPaths: ["src/gate-policy.ts"], ciConclusion: "failure" }));
  assert.deepEqual(early.merge === false ? early.passed : null, [], "the never-list is checked first");
});

// ---- the job id in a PR body ----------------------------------------------------

test("jobIdFromBody finds the id in prose and refuses a malformed one", () => {
  assert.equal(jobIdFromBody("Closes job_4c0ecc28548b."), "job_4c0ecc28548b");
  assert.equal(jobIdFromBody("job_4c0ecc28548"), null, "eleven hex digits is not a job id");
  assert.equal(jobIdFromBody("no id here"), null);
  assert.equal(jobIdFromBody(""), null);
});

// ---- CI, where an unreported check is not a pass --------------------------------

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

// ---- the policy document --------------------------------------------------------

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
  "## Refused paths",
  "",
  ...AUTO_MERGE_REFUSED_PATHS.map((p) => `- path \`${p.pattern.source}\` ${p.why}`),
  "",
  "## Required CI",
  "",
  ...AUTO_MERGE_REQUIRED_CI.map((r) => `- step \`${requiredCiLabel(r)}\``),
  "",
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
  return fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
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

test("loadMergePolicy accepts the signed policy and refuses one that names fewer checks than the code enforces", async () => {
  const ok = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, GOOD_POLICY)));
  assert.ok("policy" in ok, "the signed policy must load");
  assert.equal(ok.policy.version, "1");

  // A check the Worker enforces and the document does not describe. The document is
  // what a human reads to know what the machine may do alone, so a code check it does
  // not name is a merge nobody authorised.
  const short = GOOD_POLICY.replace(`- \`ci_green\` refuses on its own.\n`, "");
  const refused = await loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, short)));
  assert.ok("error" in refused);
  assert.match(refused.error, /does not name ci_green/);
});

test("loadMergePolicy refuses a signed policy whose refused paths or required steps differ from the code, in either direction", async () => {
  const load = async (body: string) => loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, body)));
  const migrations = AUTO_MERGE_REFUSED_PATHS.find((p) => p.pattern.source.includes("migrations"))!;
  const migrationLine = `- path \`${migrations.pattern.source}\` ${migrations.why}\n`;

  // Dropped from the document: the version 1 document, which has no such section, is
  // this case for every entry, so a version 1 policy loads nothing under this code.
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

test("parseMergePolicy does not read a refused path or a step as a check id", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.deepEqual(parsed.policy.checks, [...POLICY_CHECKS]);
  assert.equal(parsed.policy.refusedPaths.length, AUTO_MERGE_REFUSED_PATHS.length);
  assert.equal(parsed.policy.requiredCi.length, AUTO_MERGE_REQUIRED_CI.length);
});

// ---- the document that actually ships -------------------------------------------

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
  assert.deepEqual(parsed.policy.requiredCi, AUTO_MERGE_REQUIRED_CI.map(requiredCiLabel));
  assert.equal(parsed.policy.version, "2");
});

test("every required CI step is a step the CI workflow actually has", () => {
  // A required step the workflow does not have refuses every PR, silently, from the
  // day the step is renamed. Checked against the shipped workflow text.
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const stepNames = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim());
  assert.match(workflow, /^  checks:\n    name: checks$/m);
  for (const r of AUTO_MERGE_REQUIRED_CI) {
    assert.equal(r.workflow, ".github/workflows/ci.yml");
    assert.ok(stepNames.includes(r.step), `ci.yml has no step named '${r.step}'`);
  }
});

// ---- the audit rows -------------------------------------------------------------

test("the decline audit row names the policy version, the PR, the failing check and why", () => {
  const facts = greenPr({ ciConclusion: "failure", ciNote: "checks=failure" });
  const verdict = evaluatePolicy(facts);
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
      "body_names_job",
      "author_is_driver",
      "base_is_default_branch",
    ],
    at: "2026-09-12T03:00:00.000Z",
  });
});

test("the merge audit row names the policy version, the job, the driver and both shas", () => {
  const facts = greenPr();
  const verdict = evaluatePolicy(facts);
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

// ---- F4: the TICK, which nothing had ever run -------------------------------------
//
// Audit 2026-09-13, finding F4. Every check above drives `evaluatePolicy`, a pure
// function with hand-built facts. `autoMergeTick` is what production calls
// (src/improve/tick.ts), and no test imported it. So the seven checks were verified
// and the thing that consults them was not: a tick that skipped loadMergePolicy, or
// ignored `enabled: false`, or merged regardless of the verdict, would have left this
// file entirely green.
//
// auto-merge is the one policy still shipping disabled, which makes the first two
// cases the ones that matter: they are the code that runs today.

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
    // The strongest assertion is not that nothing merged, it is that nothing was
    // even LOOKED at: `enabled` is read before any repo is resolved.
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

// The enabled cases. These are what the tick WOULD do, and nothing has ever run them.

const OWNER = "/repos/DrDustinEdwards/capsid";
const HEAD_SHA = "bfae8ca9012345678901234567890123456789ab";

function tickRoutes(changedFiles: string[]) {
  return {
    [`GET ${OWNER}`]: { body: { default_branch: "master" } },
    [`GET ${OWNER}/pulls`]: {
      body: [{ number: 23, body: "Closes job_4c0ecc28548b.", head: { sha: HEAD_SHA }, base: { ref: "master" } }],
    },
    [`GET ${OWNER}/pulls/23/files`]: { body: changedFiles.map((filename) => ({ filename })) },
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: {
      body: { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] },
    },
    [`PUT ${OWNER}/pulls/23/merge`]: { body: { sha: "merged00000000000000000000000000000000000" } },
    ...ciRunRoutes(AUTO_MERGE_REQUIRED_CI.map((r) => r.step)),
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

async function enabledEnv(claimedBy = "agent:capsid-driver") {
  return tickEnv(await signTaskBody(SECRET, GOOD_POLICY), {
    jobs: [{ id: "job_4c0ecc28548b", namespace: "capsid", claimed_by: claimedBy, status: "claimed" }],
    agents: [
      { name: "capsid-driver", kind: "driver", revoked_at: null },
      { name: "seat", kind: "seat", revoked_at: null },
    ],
  });
}

test("PLANT: an enabled policy merges a green PR, through the tick and not through evaluatePolicy", async () => {
  const env = await enabledEnv();
  await withFetch(tickRoutes(["src/jobs.ts", "docs/schema.md"]), async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
    assert.equal(report.ran, true, report.note);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].merged, true, `the green PR was not merged: ${report.outcomes[0].why}`);
    const merges = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"));
    assert.equal(merges.length, 1, "the tick reported a merge it never issued");
  });
});

test("PLANT: an enabled policy DECLINES a protected-path PR and issues no merge", async () => {
  // The innocent direction of the plant above, and the one that matters: a tick that
  // called evaluatePolicy and merged anyway would pass the test above and fail here.
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

// ---- policy version 2, the five plants the job names, through the tick ----------------
//
// job_61cc059c8083. Each runs the real tick against a signed version 2 document, so a
// tick that ignored the verdict, or read the version 1 list, fails here.

async function tickPlant(files: string[], opts: { claimedBy?: string; steps?: string[] } = {}) {
  const env = await enabledEnv(opts.claimedBy);
  const routes = { ...tickRoutes(files), ...ciRunRoutes(opts.steps ?? AUTO_MERGE_REQUIRED_CI.map((r) => r.step)) };
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
  const { outcome, merges } = await tickPlant(["src/jobs.ts", "test/jobs.test.ts"]);
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
  assert.deepEqual(outcome.passed, [...POLICY_CHECKS]);
});

test("PLANT v2: a PR touching src/gate-policy.ts is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/jobs.ts", "src/gate-policy.ts"]);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "paths_not_refused");
  assert.match(outcome.why ?? "", /src\/gate-policy\.ts/);
});

test("PLANT v2: a PR touching migrations/ is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/jobs.ts", "migrations/0016_outcome_notes.sql"]);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "paths_not_refused");
});

test("PLANT v2: a PR whose CI lacks the integration suite is refused by the tick", async () => {
  const steps = AUTO_MERGE_REQUIRED_CI.map((r) => r.step).filter((s) => s !== "Integration tests");
  const { outcome, merges } = await tickPlant(["src/jobs.ts"], { steps });
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "ci_green");
  assert.match(outcome.why ?? "", /Integration tests/);
});

test("PLANT v2: a PR from the seat's job is refused by the tick", async () => {
  const { outcome, merges } = await tickPlant(["src/jobs.ts"], { claimedBy: "agent:seat" });
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "author_is_driver");
  assert.match(outcome.why ?? "", /kind 'seat', not a driver/);
});

test("the tick refuses when the Actions run list cannot be read", async () => {
  const env = await enabledEnv();
  const routes = { ...tickRoutes(["src/jobs.ts"]), [`GET ${OWNER}/actions/runs`]: { status: 403, text: "Resource not accessible by integration" } };
  await withFetch(routes as never, async (calls) => {
    const report = await autoMergeTick(env, new Date("2026-09-17T14:00:00Z"));
    assert.equal(report.outcomes[0].failed, "ci_green");
    assert.match(report.outcomes[0].why ?? "", /403/);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });
});

// ---- AUDIT-2026-09-16: THE TICK READ ONE PAGE ------------------------------------
//
// files and check-runs were fetched with per_page=100 and no next page was ever
// followed, so a PR with 101 changed files was judged on 100, and a protected path on
// page two passed paths_unprotected. The routes below answer the way GitHub does: at
// most `per_page` rows per call, and a Link rel="next" header while more remain.

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
  assert.equal(FILES_LIMIT, 3000, "GitHub documents 3000 as its per-PR file listing limit");
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
