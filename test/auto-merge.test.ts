import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTO_MERGE_ALLOWED_PATHS,
  AUTO_MERGE_POLICY_PATH,
  AUTO_MERGE_REFUSED_PATHS,
  AUTO_MERGE_REQUIRED_CI,
  AUTO_MERGE_SIZE_CAP,
  POLICY_CHECKS,
  loadMergePolicy,
  namespacedAllowedPaths,
  namespacedCiLabels,
  requiredCiLabel,
} from "../src/auto-merge-policy.ts";
import {
  ciVerdict,
  evaluatePolicy,
  jobIdFromBody,
  type PrFacts,
} from "../src/auto-merge-policy-evaluate.ts";
import { parseMergePolicy } from "../src/auto-merge-policy-parse.ts";
import { signTaskBody } from "../src/signed-docs.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { ALLOWED_AUTHORS, CAPSID_CI, GOOD_POLICY, SECRET, success } from "./auto-merge-fixtures.ts";

// The Worker may merge a pull request with no human when every check in
// capsid/policy/auto-merge.md passes. Each check is driven to its refusal on its own,
// because a check only ever seen passing together with the others is unverified.

const evaluate = (facts: PrFacts) => evaluatePolicy(facts, ALLOWED_AUTHORS);
type Verdict = ReturnType<typeof evaluate>;
const failed = (v: Verdict) => (v.merge ? null : v.failed);
const why = (v: Verdict) => (v.merge ? "" : v.why);

// A PR that passes every check; each test breaks one field of it.
function greenPr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 23,
    repo: "DrDustinEdwards/capsid-mcp",
    namespace: "capsid",
    baseRef: "master",
    defaultBranch: "master",
    headSha: "bfae8ca9012345678901234567890123456789ab",
    body: "Closes job_4c0ecc28548b.\n\nRefuse a swallowed parameter tag.",
    changedPaths: ["docs/schema.md"],
    filesProblem: null,
    changedLines: 40,
    existingTestEdits: [],
    ciConclusion: "success",
    ciNote: "3 check(s) green",
    ciSteps: success(CAPSID_CI),
    ciStepsProblem: null,
    headRepo: "DrDustinEdwards/capsid-mcp",
    prAuthor: "DrDustinEdwards",
    ...over,
  };
}

test("the unmodified green PR merges, and passes every check the code enforces", () => {
  const verdict = evaluate(greenPr());
  assert.equal(verdict.merge, true);
  assert.deepEqual(
    verdict.merge ? [...verdict.passed].sort() : [],
    [...POLICY_CHECKS].sort(),
    "the audit row must not understate what was verified",
  );
});

test("single-field refusals", () => {
  const cases: Array<[string, Partial<PrFacts>, string, RegExp?]> = [
    ["side branch", { baseRef: "release/2026-09" }, "base_is_default_branch"],
    ["failing CI", { ciConclusion: "failure", ciNote: "checks=failure" }, "ci_green"],
    ["nothing reported", { ciConclusion: null, ciNote: "no check run" }, "ci_green"],
    ["billing surface", { changedPaths: ["src/billing/invoice.ts"] }, "paths_not_money"],
    ["pnpm lockfile", { changedPaths: ["pnpm-lock.yaml"] }, "no_migration_workflow_lockfile"],
    ["incomplete file list", { filesProblem: "page 2 returned 502" }, "paths_not_refused"],
    [
      "steps unreadable",
      { ciSteps: [], ciStepsProblem: "the workflow run list returned 403" },
      "ci_green",
      /403/,
    ],
    [
      "no required steps for the namespace",
      { namespace: "foxhound", ciSteps: [] },
      "ci_green",
      /no required CI steps are written down/,
    ],
    [
      "over the size cap",
      { changedLines: AUTO_MERGE_SIZE_CAP + 1 },
      "size_within_cap",
      /1001 changed lines, more than 1000/,
    ],
  ];
  for (const [label, over, check, re] of cases) {
    const verdict = evaluate(greenPr(over));
    assert.equal(failed(verdict), check, label);
    if (re) assert.match(why(verdict), re, label);
  }
  assert.equal(evaluate(greenPr({ changedLines: AUTO_MERGE_SIZE_CAP })).merge, true);
});

test("head_in_base_repo: a fork's PR never merges, nor one whose fork GitHub no longer reports", () => {
  for (const headRepo of ["someone-else/capsid-mcp", null]) {
    assert.equal(failed(evaluate(greenPr({ headRepo }))), "head_in_base_repo");
  }
  // Owner and repo names are case-insensitive on GitHub.
  assert.equal(evaluate(greenPr({ headRepo: "drdustinedwards/Capsid-MCP" })).merge, true);
});

test("pr_author_allowed: only allowlisted authors proceed, in any letter case; an empty list refuses all", () => {
  for (const prAuthor of ["someone-else", "dependabot[bot]", "capsid-repo-access", null]) {
    assert.equal(failed(evaluate(greenPr({ prAuthor }))), "pr_author_allowed", `${prAuthor}`);
  }
  for (const prAuthor of [...ALLOWED_AUTHORS, "drdustinedwards"]) {
    assert.equal(evaluate(greenPr({ prAuthor })).merge, true, prAuthor);
  }
  assert.equal(failed(evaluatePolicy(greenPr(), [])), "pr_author_allowed");
});

test("ci_green: each required step, skipped, failed, pending or missing, refuses on its own", () => {
  for (const required of CAPSID_CI) {
    for (const conclusion of ["skipped", "failure", null, "absent"]) {
      const ciSteps = CAPSID_CI.flatMap((r) =>
        r !== required
          ? [{ ...r, conclusion: "success" }]
          : conclusion === "absent"
            ? []
            : [{ ...r, conclusion }],
      );
      const verdict = evaluate(greenPr({ ciSteps }));
      assert.equal(failed(verdict), "ci_green", `${required.step} ${conclusion}`);
      assert.ok(why(verdict).includes(requiredCiLabel(required)), `${required.step} ${conclusion}`);
    }
  }
});

test("ci_green: a same-named step in another job or workflow does not count", () => {
  for (const move of [{ job: "score" }, { workflow: ".github/workflows/other.yml" }]) {
    const ciSteps = success(CAPSID_CI).map((r) => (r.step === "Tests" ? { ...r, ...move } : r));
    assert.equal(evaluate(greenPr({ ciSteps })).merge, false);
  }
});

test("ci_green: one namespace's green steps do not satisfy another's", () => {
  const asDustinedwards = success(AUTO_MERGE_REQUIRED_CI.dustinedwards);
  assert.equal(failed(evaluate(greenPr({ ciSteps: asDustinedwards }))), "ci_green");
  const right = evaluate(greenPr({ namespace: "dustinedwards", ciSteps: asDustinedwards }));
  assert.equal(right.merge, true, why(right));
});

// Whether the refused list passes a path, apart from capsid's allowed paths.
const passesRefusedPaths = (changedPaths: string[]) =>
  evaluate(greenPr({ changedPaths })).passed.includes("paths_not_refused");

test("paths_not_refused: every pattern matches a sample, each sample refuses alone and beside an innocent path, and near-misses pass", () => {
  const samples = [
    "src/gate-policy.ts",
    "src/auto-merge.ts",
    "src/auto-merge-policy.ts",
    "src/auto-merge-tick.ts",
    "src/policy-sign.ts",
    "src/protected-paths.ts",
    "src/scope.ts",
    "src/signed-docs.ts",
    "src/auth.ts",
    "src/encoding.ts",
    "src/github/client.ts",
    "migrations/0016_next.sql",
    "wrangler.jsonc",
    "wrangler.jsonc.example",
    ".dev.vars",
    ".env",
    ".env.production",
    "package.json",
    "tsconfig.test.json",
    "vitest.config.ts",
    "scripts/test-budget.mjs",
    "scripts/verify-live.mjs",
    ".github/workflows/ci.yml",
    "scripts/check-all.mjs",
    "scripts/lib/slop.mjs",
    ".aislop/allow.txt",
    "workers/og/index.ts",
    "package-lock.json",
    "scripts/ship.mjs",
    "scripts/deploy.sh",
    "mcp/scripts/release.mjs",
    ".github/dependabot.yml",
    ".github/actions/setup/action.yml",
    "mcp/package.json",
    "pnpm-workspace.yaml",
    ".yarnrc.yml",
    ".npmrc",
    "Dockerfile",
    "Makefile",
    ".husky/pre-commit",
    ".gitmodules",
    // They write what pr_recorded_for_job reads.
    "src/jobs.ts",
    "src/outcome-prs.ts",
    ...["claim", "holder", "seat", "mirror", "transition", "schema"].map((p) => `src/jobs-${p}.ts`),
    "src/scope-guard.ts",
    "src/policy-sign-repo.ts",
    "src/auto-merge-tick-judge.ts",
    "src/outcome-prs-sweep.ts",
  ];
  for (const { pattern } of AUTO_MERGE_REFUSED_PATHS) {
    assert.ok(
      samples.some((s) => pattern.test(s)),
      `${pattern.source} matches no sample`,
    );
  }
  for (const path of samples) {
    for (const changedPaths of [[path], ["src/limits.ts", path]]) {
      const verdict = evaluate(greenPr({ changedPaths }));
      assert.equal(failed(verdict), "paths_not_refused", path);
      assert.ok(why(verdict).includes(path), path);
    }
  }
  for (const path of [
    "src/tick.ts",
    "docs/policy/auto-merge.md",
    "test/auto-merge.test.ts",
    "src/environment.ts",
    "src/github/refs.ts",
    "src/signed-requests.ts",
    "src/agents-schema.ts",
    "src/limits.ts",
    "CLAUDE.md",
    ".claude/commands/drive.md",
    "test-integration/jobs.test.ts",
  ]) {
    assert.ok(passesRefusedPaths([path]), `${path} was refused`);
  }
});

test("paths_allowed_for_namespace: capsid takes docs and dashboard CSS, declines anything else and names it", () => {
  for (const changedPaths of [
    ["docs/autonomy.md", "docs/research/notes.md", "docs/img/flow.svg"],
    ["dashboard/src/styles.css", "dashboard/src/views/queue.module.css"],
  ]) {
    const verdict = evaluate(greenPr({ changedPaths }));
    assert.equal(verdict.merge, true, why(verdict));
  }
  const declined: Array<[string[], string | null]> = [
    [["src/limits.ts"], "src/limits.ts"],
    [["docs/autonomy.md", "src/limits.ts"], "src/limits.ts"],
    [["docs/autonomy.md", "docs/policy/auto-merge.md"], "docs/policy/auto-merge.md"],
    [["docs/autonomy.md", "docs/Policy/auto-merge.md"], "docs/Policy/auto-merge.md"],
    [["dashboard/src/styles.css", "dashboard/src/App.tsx"], "dashboard/src/App.tsx"],
    [["dashboard/src/styles.css", "dashboard/src/styles.css.ts"], null],
    [["dashboard/src/styles.css", "dashboard/index.html"], null],
    [["dashboard/src/styles.css", "test/limits.test.ts"], null],
    [[], null],
  ];
  for (const [changedPaths, named] of declined) {
    const verdict = evaluate(greenPr({ changedPaths }));
    assert.equal(failed(verdict), "paths_allowed_for_namespace", changedPaths.join());
    if (named) assert.ok(why(verdict).includes(named), `${named} not named`);
  }
});

test("a namespace with no allowed-path limit is not held to capsid's, and nested lockfiles still refuse", () => {
  assert.equal(Object.hasOwn(AUTO_MERGE_ALLOWED_PATHS, "dustinedwards"), false);
  const own = (changedPaths: string[]) =>
    evaluate(
      greenPr({
        namespace: "dustinedwards",
        changedPaths: ["app/routes/home.tsx", ...changedPaths],
      }),
    );
  assert.ok(own(["src/limits.ts"]).passed.includes("paths_allowed_for_namespace"));
  for (const path of ["bun.lock", "mcp/bun.lock", "mcp/yarn.lock"]) {
    assert.equal(failed(own([path])), "no_migration_workflow_lockfile", path);
  }
});

test("jobIdFromBody finds the id in prose and refuses a malformed one", () => {
  assert.equal(jobIdFromBody("Closes job_4c0ecc28548b."), "job_4c0ecc28548b");
  assert.equal(jobIdFromBody("job_4c0ecc28548"), null, "eleven hex digits is not a job id");
  assert.equal(jobIdFromBody(""), null);
});

test("ciVerdict calls no checks, pending checks and a failure all not-green", () => {
  const run = (status: string, conclusion: string | null) => ({
    name: "c",
    status,
    conclusion,
  });
  assert.equal(ciVerdict([]).conclusion, null);
  assert.equal(ciVerdict([run("in_progress", null)]).conclusion, "pending");
  assert.equal(ciVerdict([run("completed", "success")]).conclusion, "success");
  assert.equal(
    ciVerdict([run("completed", "success"), run("completed", "failure")]).conclusion,
    "failure",
  );
});

// the policy document

const withoutAuthors = GOOD_POLICY.split("\n")
  .filter((l) => !l.startsWith("- author "))
  .join("\n");

async function envWithPolicy(body: string | null) {
  const { db } = fakeD1({
    documents:
      body === null
        ? []
        : [
            {
              namespace: "capsid",
              path: AUTO_MERGE_POLICY_PATH,
              title: "policy",
              body,
            },
          ],
  });
  return fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET, APP_KV: fakeKv().kv });
}
const loadSigned = async (body: string) =>
  loadMergePolicy(await envWithPolicy(await signTaskBody(SECRET, body)));
const errorOf = (r: { error: string } | object) => ("error" in r ? r.error : "");

test("parseMergePolicy reads version, switch, namespaces and authors, and refuses what is missing", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.version, "1");
  assert.equal(parsed.policy.enabled, true);
  assert.deepEqual(parsed.policy.namespaces, ["capsid"]);
  assert.deepEqual(parsed.policy.authors, ALLOWED_AUTHORS);
  for (const drop of ["- version: 1", "- enabled: true", "- namespaces: capsid"]) {
    assert.ok("error" in parseMergePolicy(GOOD_POLICY.replace(`${drop}\n`, "")), drop);
  }
  const offRoster = parseMergePolicy(
    GOOD_POLICY.replace("- namespaces: capsid", "- namespaces: capsid, julieedwards"),
  );
  assert.match(errorOf(offRoster), /julieedwards/);
  // No author lines, and a heading with nothing under it, both fail closed.
  for (const body of [withoutAuthors, withoutAuthors.replace("## Allowed PR authors\n\n", "")]) {
    assert.match(errorOf(parseMergePolicy(body)), /no PR author/);
  }
});

test("parseMergePolicy files allowed paths and steps under their namespace heading, and nothing past the next heading", () => {
  const parsed = parseMergePolicy(GOOD_POLICY);
  assert.ok("policy" in parsed);
  assert.deepEqual(parsed.policy.allowedPaths, namespacedAllowedPaths());
  const orphanPath = GOOD_POLICY.replace("## Allowed paths, capsid", "## Allowed paths");
  assert.match(errorOf(parseMergePolicy(orphanPath)), /allowed path .* under no namespace heading/);
  const orphanStep = GOOD_POLICY.replace("## Required CI, capsid", "## Required CI");
  assert.match(errorOf(parseMergePolicy(orphanStep)), /under no namespace heading/);
  for (const line of [
    "- allow `^src/` smuggled",
    "- step `.github/workflows/ci.yml / checks / Smuggled`",
  ]) {
    assert.ok(
      "error" in parseMergePolicy(`${GOOD_POLICY}\n## What a merge means\n\n${line}\n`),
      line,
    );
  }
});

test("loadMergePolicy refuses a policy that is absent, unsigned, or edited after signing", async () => {
  assert.match(errorOf(await loadMergePolicy(await envWithPolicy(null))), /no merge policy/);
  const unsigned = await loadMergePolicy(await envWithPolicy(GOOD_POLICY));
  assert.match(errorOf(unsigned), /carries no capsid-task-signature/);
  const signed = await signTaskBody(SECRET, GOOD_POLICY);
  const tampered = signed.replace("- namespaces: capsid", "- namespaces: capsid, foxhound");
  assert.match(
    errorOf(await loadMergePolicy(await envWithPolicy(tampered))),
    /does not match its body/,
  );
});

test("a field added to the frontmatter of a signed policy is refused, not read", async () => {
  // The signature covers the body only, and the parser returns the first `- <name>:` line it sees.
  const signed = await signTaskBody(
    SECRET,
    GOOD_POLICY.replace("- enabled: true", "- enabled: false"),
  );
  for (const plant of ["- enabled: true", "- namespaces: capsid, dustinedwards", "- version: 99"]) {
    const loaded = await loadMergePolicy(
      await envWithPolicy(signed.replace(/^---\n/, `---\n${plant}\n`)),
    );
    assert.ok("error" in loaded, `'${plant}' in the frontmatter was accepted`);
    assert.match(loaded.error, /besides the capsid-task-signature line/);
  }
});

test("loadMergePolicy accepts the signed policy and refuses one that differs from the code, in either direction", async () => {
  const ok = await loadSigned(GOOD_POLICY);
  assert.ok("policy" in ok, errorOf(ok));

  const refusedLine = (find: string) => {
    const p = AUTO_MERGE_REFUSED_PATHS.find((x) => x.pattern.source.includes(find))!;
    return `- path \`${p.pattern.source}\` ${p.why}\n`;
  };
  const migrations = refusedLine("migrations");
  const css = AUTO_MERGE_ALLOWED_PATHS.capsid.find((p) => p.pattern.source.includes("css"))!;
  const cssLine = `- allow \`${css.pattern.source}\` ${css.why}\n`;
  // Function replacements: the patterns end in "$", which a replacement string expands.
  const cases: Array<[string, string, RegExp]> = [
    [
      GOOD_POLICY.replace("- `ci_green` refuses on its own.\n", ""),
      "check",
      /does not name ci_green/,
    ],
    [
      GOOD_POLICY.replace(migrations, () => ""),
      "refused dropped",
      /refused paths does not list .*migrations/,
    ],
    [
      GOOD_POLICY.replace(migrations, () => `${migrations}- path \`^docs/\` docs\n`),
      "refused added",
      /lists \^docs\/, which this Worker does not enforce/,
    ],
    [
      GOOD_POLICY.replace("- step `.github/workflows/ci.yml / checks / Integration tests`\n", ""),
      "step dropped",
      /required CI steps does not list .*Integration tests/,
    ],
    [
      GOOD_POLICY.replace(cssLine, () => ""),
      "allowed dropped",
      /allowed paths does not list capsid \/ .*css/,
    ],
    [
      GOOD_POLICY.replace(cssLine, () => `${cssLine}- allow \`^src/\` src\n`),
      "allowed added",
      /allowed paths lists capsid \/ \^src\/, which this Worker does not enforce/,
    ],
    [withoutAuthors, "no authors", /no PR author/],
  ];
  for (const [body, label, re] of cases) assert.match(errorOf(await loadSigned(body)), re, label);

  // Dropping the whole section would leave capsid unlimited.
  const noAllowed = GOOD_POLICY.split("\n")
    .filter((l) => !l.startsWith("- allow ") && !l.startsWith("## Allowed paths"))
    .join("\n");
  assert.ok(
    "error" in (await loadSigned(noAllowed)),
    "a policy that dropped capsid's limit loaded",
  );
  assert.ok("error" in (await loadSigned(GOOD_POLICY.split("## Refused paths")[0])));
});

test("the shipped policy document names exactly the checks the code enforces", () => {
  const shipped = readFileSync(
    join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"),
    "utf8",
  );
  const parsed = parseMergePolicy(shipped);
  assert.ok("policy" in parsed, errorOf(parsed));
  assert.deepEqual([...parsed.policy.checks].sort(), [...POLICY_CHECKS].sort());
  assert.deepEqual(
    parsed.policy.refusedPaths,
    AUTO_MERGE_REFUSED_PATHS.map((p) => p.pattern.source),
  );
  assert.deepEqual(parsed.policy.requiredCi, namespacedCiLabels());
  assert.deepEqual(parsed.policy.allowedPaths, namespacedAllowedPaths());
  assert.deepEqual(parsed.policy.authors, ["DrDustinEdwards", "capsid-repo-access[bot]"]);
  assert.equal(parsed.policy.enabled, true);
  const capLine = shipped.split("\n").find((l) => l.startsWith("- `size_within_cap`"));
  assert.match(
    capLine ?? "",
    new RegExp(`at most ${AUTO_MERGE_SIZE_CAP.toLocaleString("en-US")} lines`),
  );
});

test("every required CI step is a step the CI workflow actually has", () => {
  // A renamed step would refuse every PR silently. Capsid only: dustinedwards' workflow is not in this repo.
  const workflow = readFileSync(
    join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const stepNames = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim());
  assert.match(workflow, /^  checks:\n    name: checks$/m);
  for (const r of CAPSID_CI) {
    assert.equal(r.workflow, ".github/workflows/ci.yml");
    assert.ok(stepNames.includes(r.step), `ci.yml has no step named '${r.step}'`);
  }
});
