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
  ciVerdict,
  evaluatePolicy,
  jobIdFromBody,
  loadMergePolicy,
  parseMergePolicy,
  namespacedAllowedPaths,
  namespacedCiLabels,
  requiredCiLabel,
  type PrFacts,
} from "../src/auto-merge-policy.ts";
import { FILES_LIMIT } from "../src/github/pr-files.ts";
import { AWAITING_SEAT_KEY, autoMergeTick, mergeParams } from "../src/auto-merge-tick.ts";
import { SUSPENDED_KEY } from "../src/merge-units.ts";
import { PAUSED_KEY } from "../src/merge-safety.ts";
import { signTaskBody } from "../src/signed-docs.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The Worker may merge a pull request with no human when every check in
// capsid/policy/auto-merge.md passes. Each check is driven to its refusal on its own,
// because a check only ever seen passing together with the others is unverified.

const SECRET = "test-improve-secret";
const CAPSID_CI = AUTO_MERGE_REQUIRED_CI.capsid;
// The author allowlist lives only in the signed document; evaluatePolicy gets it from the loaded policy.
const ALLOWED_AUTHORS = ["DrDustinEdwards", "capsid-repo-access[bot]"];
const evaluate = (facts: PrFacts) => evaluatePolicy(facts, ALLOWED_AUTHORS);
type Verdict = ReturnType<typeof evaluate>;
const failed = (v: Verdict) => (v.merge ? null : v.failed);
const why = (v: Verdict) => (v.merge ? "" : v.why);
const success = <T extends object>(rows: T[]) => rows.map((r) => ({ ...r, conclusion: "success" }));

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
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    jobStatus: "done",
    jobPrUrls: ["https://github.com/DrDustinEdwards/capsid-mcp/pull/23"],
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
    ["no job id", { body: "a tidy little change", jobId: null }, "body_names_job"],
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

// A job-less PR merges only in a promoted unit, and every other check still applies.
test("a job-less PR merges only in a promoted unit", () => {
  const over = {
    body: "from a project thread",
    jobId: null,
    jobStatus: null,
    jobPrUrls: [],
  };
  const unit = { unit: "capsid / docs" };
  const earned = evaluatePolicy(greenPr(over), ALLOWED_AUTHORS, unit);
  assert.equal(earned.merge, true, why(earned));
  const red = evaluatePolicy(greenPr({ ...over, ciConclusion: "failure" }), ALLOWED_AUTHORS, unit);
  assert.equal(failed(red), "ci_green");
  assert.equal(failed(evaluatePolicy(greenPr(over), ALLOWED_AUTHORS, null)), "body_names_job");
});

test("a job completed without a claim passes whoever holds it", () => {
  for (const jobClaimedBy of ["access:dustin@example.com", "agent:seat", "opkey:9f2c1a"]) {
    const verdict = evaluate(greenPr({ jobClaimedBy }));
    assert.equal(verdict.merge, true, `${jobClaimedBy}: ${why(verdict)}`);
  }
});

test("head_in_base_repo: a fork's PR never merges, nor one whose fork GitHub no longer reports", () => {
  for (const headRepo of ["someone-else/capsid-mcp", null]) {
    assert.equal(failed(evaluate(greenPr({ headRepo }))), "head_in_base_repo");
  }
  // Owner and repo names are case-insensitive on GitHub.
  assert.equal(evaluate(greenPr({ headRepo: "drdustinedwards/Capsid-MCP" })).merge, true);
});

test("job_handed_on: a job that has not handed a PR on never merges", () => {
  for (const jobStatus of ["queued", "claimed", "failed", "superseded", null]) {
    assert.equal(failed(evaluate(greenPr({ jobStatus }))), "job_handed_on", `${jobStatus}`);
  }
  assert.equal(evaluate(greenPr({ jobStatus: "blocked" })).merge, true);
});

test("pr_recorded_for_job: a PR the job's holder never recorded never merges", () => {
  const cases: Array<[string, string[]]> = [
    ["no record at all", []],
    ["another PR", ["https://github.com/DrDustinEdwards/capsid-mcp/pull/22"]],
    [
      "a number that only starts the same",
      ["https://github.com/DrDustinEdwards/capsid-mcp/pull/234"],
    ],
    ["the same number in another repo", ["https://github.com/DrDustinEdwards/foxhound/pull/23"]],
    ["a document key", ["capsid/notes/done.md"]],
  ];
  for (const [label, jobPrUrls] of cases) {
    assert.equal(failed(evaluate(greenPr({ jobPrUrls }))), "pr_recorded_for_job", label);
  }
  // The same URL in another case, or with a trailing slash, is still this PR.
  const same = ["https://github.com/drdustinedwards/capsid-mcp/pull/23/"];
  assert.equal(evaluate(greenPr({ jobPrUrls: same })).merge, true);
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

test("ci_green: carrel and capsomer hold the steps their workflows run, and a rename refuses", () => {
  for (const namespace of ["carrel", "capsomer"]) {
    const required = AUTO_MERGE_REQUIRED_CI[namespace];
    const merged = evaluate(greenPr({ namespace, ciSteps: success(required) }));
    assert.equal(merged.merge, true, why(merged));
    for (const step of required) {
      const variants = [
        success(required).map((r, i) =>
          required[i] === step ? { ...r, step: `${r.step} (renamed)` } : r,
        ),
        success(required).map((r, i) =>
          required[i] === step ? { ...r, conclusion: "skipped" } : r,
        ),
        success(required.filter((r) => r !== step)),
      ];
      for (const ciSteps of variants) {
        const verdict = evaluate(greenPr({ namespace, ciSteps }));
        assert.equal(failed(verdict), "ci_green", `${namespace} ${requiredCiLabel(step)}`);
        assert.ok(why(verdict).includes(requiredCiLabel(step)));
      }
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

test("a failing check reports only the checks that actually passed before it", () => {
  assert.equal(POLICY_CHECKS[POLICY_CHECKS.length - 1], "ci_green");
  const late = evaluate(greenPr({ ciConclusion: "failure" }));
  assert.deepEqual(late.merge ? null : late.passed, POLICY_CHECKS.slice(0, -1));
  const early = evaluate(
    greenPr({ changedPaths: ["src/gate-policy.ts"], ciConclusion: "failure" }),
  );
  assert.deepEqual(early.merge ? null : early.passed, []);
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
    ...["claim", "holder", "seat", "mirror", "transition"].map((p) => `src/jobs-${p}.ts`),
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
    "src/jobs-schema.ts",
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
  ...Object.entries(AUTO_MERGE_ALLOWED_PATHS).flatMap(([ns, rows]) => [
    `## Allowed paths, ${ns}`,
    "",
    ...rows.map((r) => `- allow \`${r.pattern.source}\` ${r.why}`),
    "",
  ]),
  // loadMergePolicy compares the document's steps with the code's in both directions.
  ...Object.entries(AUTO_MERGE_REQUIRED_CI).flatMap(([ns, rows]) => [
    `## Required CI, ${ns}`,
    "",
    ...rows.map((r) => `- step \`${requiredCiLabel(r)}\``),
    "",
  ]),
].join("\n");

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

test("the merge audit row names the policy version, the job, the driver, both shas and the path class", () => {
  const facts = greenPr();
  const verdict = evaluate(facts);
  const row = mergeParams(
    "1",
    facts,
    verdict.merge ? verdict.passed : [],
    "f852780aabbccddeeff0011223344556677889900",
    new Date("2026-09-12T03:00:00Z"),
    "docs",
  );
  assert.deepEqual(row, {
    policy_version: "1",
    path_class: "docs",
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
// The checks above drive evaluatePolicy with hand-built facts. A tick that skipped
// loadMergePolicy, ignored `enabled: false`, or merged regardless of the verdict would
// leave them green, so the tick is driven against a signed document and fake GitHub routes.

const NS_ROW = [
  {
    namespace: "capsid",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]),
  },
];
const OWNER = "/repos/DrDustinEdwards/capsid";
const HEAD_SHA = "bfae8ca9012345678901234567890123456789ab";
const PR_URL = "https://github.com/DrDustinEdwards/capsid/pull/23";
const MERGED_SHA = "merged00000000000000000000000000000000000";

async function tickEnv(policyBody: string | null, over: Record<string, unknown> = {}) {
  const d1 = fakeD1({
    namespaces: NS_ROW,
    documents:
      policyBody === null
        ? []
        : [
            {
              namespace: "capsid",
              path: AUTO_MERGE_POLICY_PATH,
              title: "policy",
              body: policyBody,
            },
          ],
    ...over,
  });
  const kv = fakeKv({ seedToken: true });
  return {
    d1,
    kv,
    env: fakeEnv({ DB: d1.db, APP_KV: kv.kv, IMPROVE_SCORE_SECRET: SECRET }),
  };
}

// The job as a driver leaves it: done, with the PR it opened as its result_ref.
async function enabledEnv(
  opts: {
    job?: Record<string, unknown>;
    outcomePrs?: Array<{ job_id: string; pr_url: string }>;
    policy?: string;
  } = {},
) {
  return tickEnv(await signTaskBody(SECRET, opts.policy ?? GOOD_POLICY), {
    jobs: [
      {
        id: "job_4c0ecc28548b",
        namespace: "capsid",
        claimed_by: "agent:capsid-driver",
        status: "done",
        result_ref: PR_URL,
        ...opts.job,
      },
    ],
    jobOutcomePrs: opts.outcomePrs ?? [],
    agents: [{ name: "capsid-driver", kind: "driver", revoked_at: null }],
  });
}
type Env = Awaited<ReturnType<typeof tickEnv>>["env"];

function ciRunRoutes() {
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
    // The older CI run and the unrelated workflow's run exercise the newest-run and path filters.
    [`GET ${OWNER}/actions/runs/900/jobs`]: { body: { jobs: [] } },
    [`GET ${OWNER}/actions/runs/950/jobs`]: {
      body: {
        jobs: [
          {
            name: "checks",
            steps: [
              { name: "Install dependencies", conclusion: "success" },
              ...CAPSID_CI.map((r) => ({
                name: r.step,
                conclusion: "success",
              })),
            ],
          },
          {
            name: "deploy",
            steps: [{ name: "Deploy", conclusion: "skipped" }],
          },
        ],
      },
    },
  };
}

function tickRoutes(
  changedFiles: string[],
  headRepo: string | null = "DrDustinEdwards/capsid",
  author: string | null = "DrDustinEdwards",
) {
  return {
    [`GET ${OWNER}`]: { body: { default_branch: "master" } },
    [`GET ${OWNER}/pulls`]: {
      body: [
        {
          number: 23,
          body: "Closes job_4c0ecc28548b.",
          head: {
            sha: HEAD_SHA,
            repo: headRepo === null ? null : { full_name: headRepo },
          },
          base: { ref: "master" },
          user: author === null ? null : { login: author },
        },
      ],
    },
    [`GET ${OWNER}/pulls/23/files`]: {
      body: changedFiles.map((filename) => ({
        filename,
        status: "modified",
        additions: 1,
        deletions: 0,
      })),
    },
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: {
      body: {
        check_runs: [{ name: "test", status: "completed", conclusion: "success" }],
      },
    },
    [`PUT ${OWNER}/pulls/23/merge`]: { body: { sha: MERGED_SHA } },
    ...ciRunRoutes(),
  };
}

// The same routes with PR 23's files answered by `body` (renames, statuses, line counts).
const filesRoutes = (body: unknown) => ({
  ...tickRoutes([]),
  [`GET ${OWNER}/pulls/23/files`]: { body },
});

const isMerge = (c: { method: string; path: string }) =>
  c.method === "PUT" && c.path.endsWith("/merge");

async function tickWith(env: Env, routes: unknown, minute = 0) {
  let report!: Awaited<ReturnType<typeof autoMergeTick>>;
  let merges = 0;
  let calls: Array<{
    method: string;
    path: string;
    search?: string;
    body?: unknown;
  }> = [];
  await withFetch(routes as never, async (c) => {
    report = await autoMergeTick(env, new Date(Date.UTC(2026, 8, 25, 12, minute)));
    calls = c as typeof calls;
    merges = calls.filter(isMerge).length;
  });
  assert.equal(report.ran, true, report.note);
  return { report, outcome: report.outcomes[0], merges, calls };
}
const tickFiles = async (files: string[], opts?: Parameters<typeof enabledEnv>[0]) =>
  tickWith((await enabledEnv(opts)).env, tickRoutes(files));

test("a policy that is disabled, unsigned or absent makes the tick reach GitHub not once", async () => {
  const cases: Array<[string | null, RegExp]> = [
    [
      await signTaskBody(SECRET, GOOD_POLICY.replace("- enabled: true", "- enabled: false")),
      /disabled/,
    ],
    [GOOD_POLICY, /carries no capsid-task-signature/],
    [null, /no merge policy/],
  ];
  for (const [body, note] of cases) {
    const { env } = await tickEnv(body);
    await withFetch({}, async (calls) => {
      const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
      assert.equal(report.ran, false);
      assert.match(report.note, note);
      assert.equal(report.outcomes.length, 0);
      assert.equal(calls.length, 0, `GitHub was called: ${JSON.stringify(calls)}`);
    });
  }
});

test("the tick merges a green PR and declines a protected-path one without a merge call", async () => {
  const green = await tickFiles(["docs/schema.md", "dashboard/src/styles.css"]);
  assert.equal(green.outcome.merged, true, green.outcome.why ?? "");
  assert.equal(green.merges, 1);
  assert.deepEqual(green.outcome.passed, [...POLICY_CHECKS]);

  const protectedPr = await tickFiles([".github/workflows/nightly.yml"]);
  assert.equal(protectedPr.outcome.merged, false);
  assert.ok(protectedPr.outcome.failed);
  assert.equal(protectedPr.merges, 0);
});

test("a rename is judged under both names", async () => {
  const toDocs = [
    {
      filename: "docs/limits.md",
      previous_filename: "src/limits.ts",
      status: "renamed",
    },
  ];
  const outOfSrc = await tickWith((await enabledEnv()).env, filesRoutes(toDocs));
  assert.equal(outOfSrc.merges, 0);
  assert.equal(outOfSrc.outcome.failed, "paths_allowed_for_namespace");
  assert.match(outOfSrc.outcome.why ?? "", /src\/limits\.ts/);

  const outOfRefused = [
    { filename: "src/limits.ts" },
    {
      filename: "src/old-merge.ts",
      previous_filename: "src/auto-merge.ts",
      status: "renamed",
    },
  ];
  const refused = await tickWith((await enabledEnv()).env, filesRoutes(outOfRefused));
  assert.equal(refused.merges, 0);
  assert.equal(refused.outcome.failed, "paths_not_refused");
  assert.match(refused.outcome.why ?? "", /src\/auto-merge\.ts/);
});

test("a PR whose files GitHub reports without line counts is declined, not counted as zero", async () => {
  const { outcome, merges } = await tickWith(
    (await enabledEnv()).env,
    filesRoutes([{ filename: "docs/autonomy.md" }]),
  );
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "size_within_cap");
  assert.match(outcome.why ?? "", /no line counts/);
});

test("a PR recorded only in job_outcome_prs still merges", async () => {
  const { outcome, merges } = await tickFiles(["docs/schema.md"], {
    job: { result_ref: "capsid/notes/done.md" },
    outcomePrs: [{ job_id: "job_4c0ecc28548b", pr_url: PR_URL }],
  });
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
});

test("a fork PR naming a done job is refused by the tick", async () => {
  const { outcome, merges } = await tickWith(
    (await enabledEnv()).env,
    tickRoutes(["docs/schema.md"], "attacker/capsid"),
  );
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "head_in_base_repo");
});

test("the tick refuses when the Actions run list cannot be read", async () => {
  const routes = {
    ...tickRoutes(["docs/schema.md"]),
    [`GET ${OWNER}/actions/runs`]: {
      status: 403,
      text: "Resource not accessible by integration",
    },
  };
  const { outcome, merges } = await tickWith((await enabledEnv()).env, routes);
  assert.equal(outcome.failed, "ci_green");
  assert.match(outcome.why ?? "", /403/);
  assert.equal(merges, 0);
});

// The merge is pinned to the head the policy judged: without `sha`, a push between the
// reads and the merge would be merged unjudged, and GitHub answers 409 when it moved.

const auditActions = (d1: { recorded: Array<{ sql: string; params: unknown[] }> }) =>
  d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql)).map((r) => r.params[1]);

test("the merge request carries the head sha the policy evaluated", async () => {
  const { merges, calls, outcome } = await tickFiles(["docs/schema.md"]);
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
  assert.deepEqual(calls.find(isMerge)?.body, {
    merge_method: "merge",
    sha: HEAD_SHA,
  });
});

test("a head that moved before the merge (GitHub 409) is not merged, audited, and does not abort the tick", async () => {
  const { d1, kv, env } = await enabledEnv();
  const routes = {
    ...tickRoutes(["docs/schema.md"]),
    [`PUT ${OWNER}/pulls/23/merge`]: {
      status: 409,
      body: { message: "Head branch was modified." },
    },
  };
  const { outcome } = await tickWith(env, routes);
  assert.equal(outcome.merged, false);
  assert.equal(outcome.failed, "head_moved");
  assert.match(outcome.why ?? "", new RegExp(HEAD_SHA));
  const audits = d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params[1], "auto-merge-declined");
  assert.equal(JSON.parse(String(audits[0].params[4])).head_sha, HEAD_SHA);
  const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string);
  assert.deepEqual(
    awaiting.map((a: { failed: string }) => a.failed),
    ["head_moved"],
  );
});

test("the awaiting-seat set carries each PR's merge class, why and the judged head sha", async () => {
  for (const [paths, cls, pathClass] of [
    [["src/inbox.ts"], "approve", "src-routine"],
    [["migrations/0099_sample.sql"], "seat", "migration"],
    [["docs/schema.md", "src/billing/plan.ts"], "typed", "money"],
  ] as const) {
    const { kv, env } = await enabledEnv();
    const { outcome } = await tickWith(env, tickRoutes([...paths]));
    assert.equal(outcome.merged, false, paths.join());
    const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string);
    assert.equal(awaiting.length, 1);
    assert.equal(awaiting[0].class, cls, paths.join());
    assert.equal(awaiting[0].path_class, pathClass);
    assert.ok(awaiting[0].class_reasons.length > 0, "a class with no reason");
    // The Portal's Approve sends this sha.
    assert.equal(awaiting[0].head_sha, HEAD_SHA);
  }
});

// paging: every page of files and check runs is read

function paged<T>(rows: T[], wrap: (page: T[]) => unknown = (page) => page) {
  return (_body: unknown, search: URLSearchParams) => {
    const perPage = Number(search.get("per_page") ?? 30);
    const page = Number(search.get("page") ?? 1);
    const more = page * perPage < rows.length;
    return {
      body: wrap(rows.slice((page - 1) * perPage, page * perPage)),
      ...(more
        ? {
            headers: {
              Link: `<https://api.github.com/repositories/1/x?per_page=${perPage}&page=${page + 1}>; rel="next"`,
            },
          }
        : {}),
    };
  };
}

function pagedRoutes(
  files: string[],
  runs: Array<{ name: string; status: string; conclusion: string | null }>,
) {
  return {
    ...tickRoutes([]),
    [`GET ${OWNER}/pulls/23/files`]: paged(
      files.map((filename) => ({ filename, additions: 1, deletions: 0 })),
    ),
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: paged(runs, (page) => ({
      total_count: runs.length,
      check_runs: page,
    })),
  };
}

const safeFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => `docs/page-${String(i).padStart(4, "0")}.md`);
const green = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `check-${i}`,
    status: "completed",
    conclusion: "success",
  }));
const tickPaged = async (routes: unknown) => tickWith((await enabledEnv()).env, routes);

test("a protected path or a failing check on the second page is seen, and the PR is not merged", async () => {
  const file = await tickPaged(
    pagedRoutes([...safeFiles(100), "migrations/0099_planted.sql"], green(1)),
  );
  assert.equal(file.merges, 0);
  assert.equal(file.outcome.failed, "paths_not_refused");
  assert.match(file.outcome.why ?? "", /migrations\/0099_planted\.sql/);

  const late = {
    name: "late-check",
    status: "completed",
    conclusion: "failure",
  };
  const run = await tickPaged(pagedRoutes(safeFiles(2), [...green(100), late]));
  assert.equal(run.merges, 0);
  assert.equal(run.outcome.failed, "ci_green");
  assert.match(run.outcome.why ?? "", /late-check=failure/);
});

test("paging is not a refusal: a green PR spread over several pages still merges", async () => {
  const { outcome, merges } = await tickPaged(pagedRoutes(safeFiles(250), green(150)));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
});

test("a file list GitHub truncates, or a page that fails partway, is refused, not judged on what loaded", async () => {
  // GitHub stops offering a next page at 3000 files, so a list at the ceiling cannot be told from a cut one.
  const truncated = await tickPaged(pagedRoutes(safeFiles(FILES_LIMIT), green(1)));
  assert.equal(truncated.merges, 0);
  assert.match(truncated.outcome.why ?? "", new RegExp(`at most ${FILES_LIMIT} files`));

  const files = paged(
    safeFiles(150).map((filename) => ({
      filename,
      additions: 1,
      deletions: 0,
    })),
  );
  const routes = {
    ...pagedRoutes([], green(1)),
    [`GET ${OWNER}/pulls/23/files`]: (body: unknown, search: URLSearchParams) =>
      search.get("page") === "2" ? { status: 502, text: "bad gateway" } : files(body, search),
  };
  const partial = await tickPaged(routes);
  assert.equal(partial.merges, 0);
  assert.match(partial.outcome.why ?? "", /502/);
});

// one PR cannot end the tick, and a PR naming no job costs no GitHub read

const NO_JOB_SHA = "cccc000000000000000000000000000000000000";
const NEW_SHA = "c0ffee00123456789012345678901234567890cd";

function twoPrRoutes(mergeRoute: unknown, noJobSha = NO_JOB_SHA) {
  const base = tickRoutes(["docs/schema.md"]);
  return {
    ...base,
    [`GET ${OWNER}/pulls`]: {
      body: [
        ...(base[`GET ${OWNER}/pulls`] as { body: unknown[] }).body,
        {
          number: 30,
          body: "A human's change, no job here.",
          head: {
            sha: noJobSha,
            repo: { full_name: "DrDustinEdwards/capsid" },
          },
          base: { ref: "master" },
        },
      ],
    },
    [`PUT ${OWNER}/pulls/23/merge`]: mergeRoute,
  };
}

test("a merge GitHub refuses with 405 is audited as failed, and the tick goes on to the next PR", async () => {
  const { d1, kv, env } = await enabledEnv();
  const { report } = await tickWith(
    env,
    twoPrRoutes({
      status: 405,
      body: { message: "Pull Request is not mergeable" },
    }),
  );
  assert.equal(report.outcomes.length, 2, "the throw on PR 23 stopped the tick before PR 30");
  const first = report.outcomes.find((o) => o.number === 23);
  assert.equal(first?.merged, false);
  assert.equal(first?.failed, "error");
  assert.match(first?.why ?? "", /405/);
  assert.ok(auditActions(d1).includes("auto-merge-failed"));
  const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string) as Array<{
    number: number;
    failed: string;
  }>;
  assert.deepEqual(awaiting.map((a) => [a.number, a.failed]).sort(), [
    [23, "error"],
    [30, "body_names_job"],
  ]);
});

test("a PR whose body names no job is declined without reading its files, checks or CI runs", async () => {
  const { d1, env } = await enabledEnv();
  const { report, calls } = await tickWith(env, twoPrRoutes({ body: { sha: MERGED_SHA } }));
  const skipped = report.outcomes.find((o) => o.number === 30);
  assert.equal(skipped?.failed, "body_names_job");
  const aboutPr30 = calls.filter(
    (c) =>
      c.path.includes("/pulls/30") ||
      c.path.includes(NO_JOB_SHA) ||
      (c.search ?? "").includes(NO_JOB_SHA),
  );
  assert.deepEqual(aboutPr30, [], "the tick read GitHub for a PR that names no job");
  assert.equal(report.outcomes.find((o) => o.number === 23)?.merged, true);
  assert.equal(declineRows(d1).filter((r) => r.head_sha === NO_JOB_SHA).length, 1);
});

// A decline is logged when the decision changes: the tick runs every five minutes, and a
// PR refused for the same reason on the same head leaves one audit row, not one per tick.

const PROTECTED = [".github/workflows/nightly.yml"];

function declineRows(d1: { recorded: Array<{ sql: string; params: unknown[] }> }) {
  return d1.recorded
    .filter((r) => /INSERT INTO audit_log/.test(r.sql) && r.params[1] === "auto-merge-declined")
    .map((r) => JSON.parse(String(r.params[4])) as { head_sha: string; failed: string });
}

// The same PR with its head moved to NEW_SHA: the PR list and the per-sha reads follow it.
function movedHeadRoutes(files: string[]) {
  const routes = tickRoutes(files);
  const [pr] = routes[`GET ${OWNER}/pulls`].body;
  return {
    ...routes,
    [`GET ${OWNER}/pulls`]: {
      body: [{ ...pr, head: { ...pr.head, sha: NEW_SHA } }],
    },
    [`GET ${OWNER}/commits/${NEW_SHA}/check-runs`]:
      routes[`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`],
  };
}

test("a repeated decline writes one row; a different reason or a new head writes another", async () => {
  const { d1, env } = await enabledEnv();
  await tickWith(env, tickRoutes(PROTECTED), 0);
  await tickWith(env, tickRoutes(PROTECTED), 5);
  assert.equal(declineRows(d1).length, 1, "a repeated decision was logged again");

  await tickWith(env, tickRoutes(["docs/schema.md"], "DrDustinEdwards/capsid", "someone-else"), 10);
  const reasons = declineRows(d1);
  assert.equal(reasons.length, 2);
  assert.notEqual(reasons[0].failed, reasons[1].failed);

  await tickWith(env, movedHeadRoutes(PROTECTED), 15);
  assert.deepEqual(
    declineRows(d1).map((r) => r.head_sha),
    [HEAD_SHA, HEAD_SHA, NEW_SHA],
  );
});

test("a KV read that fails still logs the decline", async () => {
  const { d1, kv, env } = await enabledEnv();
  const realGet = kv.kv.get.bind(kv.kv);
  (kv.kv as { get: unknown }).get = async (key: string, ...rest: unknown[]) => {
    if (key.startsWith("improve:auto-merge-last-decline:")) throw new Error("kv down");
    return (realGet as (k: string, ...r: unknown[]) => unknown)(key, ...rest);
  };
  await tickWith(env, tickRoutes(PROTECTED), 0);
  assert.equal(declineRows(d1).length, 1, "a KV outage lost the decline row");
});

// The executor: an approved PR the policy leaves open merges on Dustin's approval. The
// approvals live in pr_approvals, which the fake D1 does not model, so they are answered
// here and each state move the executor batches is applied to them.

type ApprovalRow = {
  id: number;
  repo: string;
  pr: number;
  head_sha: string;
  class: string;
  status: string;
  approved_by: string;
  surface: string;
  batch_id: string | null;
  approved_at: string;
};

function withApprovals(env: Env, rows: ApprovalRow[], opts: { missingTable?: boolean } = {}) {
  const db = (env as unknown as { DB: D1Database }).DB;
  const moves: Array<{
    id: unknown;
    status: unknown;
    reason: unknown;
    merge_sha: unknown;
  }> = [];
  const own = (sql: string) => /pr_approvals/.test(sql);
  const stmt = (sql: string) => {
    if (opts.missingTable) throw new Error("D1_ERROR: no such table: pr_approvals");
    const s = {
      sql,
      params: [] as unknown[],
      bind(...p: unknown[]) {
        s.params = p;
        return s;
      },
      async all() {
        const results = /^\s*SELECT/i.test(sql)
          ? rows.filter((r) => r.status === "approved" && r.repo === s.params[0])
          : [];
        return { results, meta: {} };
      },
    };
    return s;
  };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => (own(sql) ? stmt(sql) : target.prepare(sql));
      if (prop === "batch") {
        return async (statements: Array<{ sql: string; params: unknown[] }>) => {
          const out: unknown[] = [];
          for (const s of statements) {
            if (!own(s.sql)) {
              out.push((await target.batch([s as never]))[0]);
              continue;
            }
            const row = rows.find((r) => r.id === s.params[0] && r.status === "approved");
            if (row) {
              row.status = String(s.params[1]);
              moves.push({
                id: row.id,
                status: s.params[1],
                reason: s.params[3],
                merge_sha: s.params[4],
              });
            }
            out.push({
              results: row ? [{ id: row.id }] : [],
              meta: { changes: row ? 1 : 0 },
            });
          }
          return out;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { env: { ...(env as object), DB: proxy } as typeof env, moves };
}

const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: 1,
  repo: "DrDustinEdwards/capsid",
  pr: 23,
  head_sha: HEAD_SHA,
  class: "approve",
  status: "approved",
  approved_by: "access:admin@example.com",
  surface: "portal",
  batch_id: null,
  approved_at: "2026-09-24T12:00:00.000Z",
  ...over,
});

// A src change: the capsid policy does not merge it, so only an approval can.
const SRC = ["src/merge-class.ts"];
const checkRuns = (status: string, conclusion: string | null) => ({
  [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: {
    body: { check_runs: [{ name: "test", status, conclusion }] },
  },
});

test("an approved PR the policy leaves open merges on the approval, pinned to the approved sha, and the row moves to merged", async () => {
  const { env, moves } = withApprovals((await enabledEnv()).env, [approval()]);
  const { outcome, calls } = await tickWith(env, tickRoutes(SRC));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.match(outcome.why ?? "", /merged on the approval of access:admin@example\.com \(portal\)/);
  assert.deepEqual(calls.find(isMerge)?.body, {
    merge_method: "merge",
    sha: HEAD_SHA,
  });
  assert.deepEqual(moves, [
    {
      id: 1,
      status: "merged",
      reason: `merged on the approval of access:admin@example.com (portal) at ${HEAD_SHA.slice(0, 7)}`,
      merge_sha: MERGED_SHA,
    },
  ]);
});

test("an approval is voided, expired, refused or left open, and nothing merges unattended", async () => {
  const moneyFile = tickRoutes(["src/billing/charge.ts"]);
  const failing409 = {
    ...tickRoutes(SRC),
    [`PUT ${OWNER}/pulls/23/merge`]: {
      status: 409,
      body: { message: "Head branch was modified." },
    },
  };
  const cases: Array<[string, Partial<ApprovalRow>, unknown, string | null, RegExp?]> = [
    [
      "a new push",
      { head_sha: "f".repeat(40) },
      tickRoutes(SRC),
      "voided",
      /^new push: approved at fffffff/,
    ],
    ["7 days old", { approved_at: "2026-09-18T11:00:00.000Z" }, tickRoutes(SRC), "expired"],
    [
      "red CI",
      {},
      { ...tickRoutes(SRC), ...checkRuns("completed", "failure") },
      "voided",
      /^CI red: /,
    ],
    ["CI still running", {}, { ...tickRoutes(SRC), ...checkRuns("in_progress", null) }, null],
    ["a 409 from GitHub", {}, failing409, "voided", /^head moved: /],
    ["a money path without typed confirmation", {}, moneyFile, "refused"],
  ];
  for (const [label, over, routes, status, reason] of cases) {
    const { env, moves } = withApprovals((await enabledEnv()).env, [approval(over)]);
    const { outcome, merges } = await tickWith(env, routes);
    assert.equal(outcome.merged, false, label);
    assert.equal(merges, label === "a 409 from GitHub" ? 1 : 0, label);
    assert.equal(moves[0]?.status ?? null, status, label);
    if (reason) assert.match(String(moves[0]?.reason), reason, label);
  }
});

test("with the approvals table missing the tick runs as the policy alone", async () => {
  const { env } = withApprovals((await enabledEnv()).env, [approval()], {
    missingTable: true,
  });
  const { outcome, merges } = await tickWith(env, tickRoutes(SRC));
  assert.equal(outcome.merged, false);
  assert.equal(merges, 0);
});

// Suspended merge units and paused namespaces only narrow: they hold back what the policy
// would merge, as class approve, and a list that cannot be read holds everything.

const SINCE = "2026-09-24T00:00:00Z";
const DOCS = ["docs/autonomy.md"];

test("a suspended unit holds back a PR the policy would merge; another unit's suspension does not; an unreadable list holds all", async () => {
  const suspend = async (value: string) => {
    const { env, kv } = await enabledEnv();
    await kv.kv.put(SUSPENDED_KEY, value);
    return tickWith(env, tickRoutes(DOCS));
  };
  const held = await suspend(
    JSON.stringify([{ unit: "capsid/docs", since: SINCE, reason: "rolled back" }]),
  );
  assert.equal(held.merges, 0);
  assert.equal(held.outcome.failed, "unit_suspended");
  assert.equal(held.outcome.merge_class?.class, "approve");
  assert.match(held.outcome.merge_class?.reasons[0] ?? "", /capsid\/docs is suspended/);

  const other = await suspend(
    JSON.stringify([{ unit: "capsid/dashboard-css", since: SINCE, reason: "x" }]),
  );
  assert.equal(other.outcome.merged, true, other.outcome.why ?? "");

  const unreadable = await suspend("not json");
  assert.equal(unreadable.merges, 0);
  assert.equal(unreadable.outcome.failed, "unit_suspended");
  assert.match(unreadable.outcome.why ?? "", /could not be read/);
});

test("a paused namespace holds back a PR the policy would merge; another namespace's pause does not; an unreadable list holds all", async () => {
  const pause = async (value: string) => {
    const { env, kv } = await enabledEnv();
    await kv.kv.put(PAUSED_KEY, value);
    return tickWith(env, tickRoutes(DOCS));
  };
  const reason = "2 of the pull requests auto-merge merged were rolled back or reverted in 7 days";
  const held = await pause(JSON.stringify({ capsid: { since: SINCE, reason } }));
  assert.equal(held.merges, 0);
  assert.equal(held.outcome.failed, "namespace_paused");
  assert.equal(held.outcome.merge_class?.class, "approve");
  assert.match(held.outcome.why ?? "", /^auto-merge for capsid is paused: 2 of the pull requests/);

  const other = await pause(JSON.stringify({ carrel: { since: SINCE, reason: "rolled back" } }));
  assert.equal(other.outcome.merged, true, other.outcome.why ?? "");

  const unreadable = await pause("not json");
  assert.equal(unreadable.merges, 0);
  assert.equal(unreadable.outcome.failed, "namespace_paused");
  assert.match(unreadable.outcome.why ?? "", /could not be read/);
});

test("an approval still merges a PR in a paused namespace", async () => {
  const { env, kv } = await enabledEnv();
  await kv.kv.put(PAUSED_KEY, JSON.stringify({ capsid: { since: SINCE, reason: "rolled back" } }));
  const a = withApprovals(env, [approval()]);
  const { outcome, merges } = await tickWith(a.env, tickRoutes(DOCS));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
  assert.equal(a.moves.length, 1);
});

// A unit the signed policy lists under ## Auto units widens its namespace's allowed paths, and only those.

const unitPolicy = (units: string[]) =>
  `${GOOD_POLICY}\n\n## Auto units\n\n${units.map((u) => `- unit \`${u}\``).join("\n")}\n`;

test("a promoted unit merges what the namespace's paths held back; another unit's promotion does not; a suspension still holds it", async () => {
  const unitTick = async (units: string[]) =>
    tickWith(
      (await enabledEnv({ policy: unitPolicy(units) })).env,
      tickRoutes(["test/jobs.test.ts"]),
    );
  const promoted = await unitTick(["capsid / tests"]);
  assert.equal(promoted.outcome.merged, true, promoted.outcome.why ?? "");
  assert.equal(promoted.merges, 1);
  const other = await unitTick(["capsid / dashboard-code"]);
  assert.equal(other.merges, 0);
  assert.equal(other.outcome.failed, "paths_allowed_for_namespace");

  const { env, kv } = await enabledEnv({
    policy: unitPolicy(["capsid / tests"]),
  });
  await kv.kv.put(
    SUSPENDED_KEY,
    JSON.stringify([{ unit: "capsid/tests", since: SINCE, reason: "x" }]),
  );
  const suspended = await tickWith(env, tickRoutes(["test/jobs.test.ts"]));
  assert.equal(suspended.merges, 0);
  assert.equal(suspended.outcome.failed, "unit_suspended");
});

// An existing test, changed, always waits for Dustin, even in a promoted unit.

const testFilesTick = async (
  files: Array<Record<string, unknown>>,
  approvals: ApprovalRow[] = [],
) => {
  const { env } = await enabledEnv({ policy: unitPolicy(["capsid / tests"]) });
  return tickWith(approvals.length ? withApprovals(env, approvals).env : env, filesRoutes(files));
};

test("a PR that only adds tests merges in a promoted tests unit; any change to an existing test is held as approve", async () => {
  const added = await testFilesTick([
    {
      filename: "test/new.test.ts",
      status: "added",
      additions: 40,
      deletions: 0,
    },
    {
      filename: "test/old.test.ts",
      status: "modified",
      additions: 6,
      deletions: 0,
    },
  ]);
  assert.equal(added.outcome.merged, true, added.outcome.why ?? "");
  assert.equal(added.outcome.merge_class?.class, "auto");

  const held: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "edited",
      {
        filename: "test/old.test.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
      /^changes an existing test: test\/old\.test\.ts/,
    ],
    [
      "deleted",
      {
        filename: "test/gone.test.ts",
        status: "removed",
        additions: 0,
        deletions: 30,
      },
      /test\/gone\.test\.ts/,
    ],
    [
      "renamed",
      {
        filename: "test/new-name.test.ts",
        previous_filename: "test/old-name.test.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      /test\/old-name\.test\.ts/,
    ],
    [
      "no status",
      { filename: "test/old.test.ts", additions: 3, deletions: 0 },
      /test\/old\.test\.ts/,
    ],
  ];
  for (const [label, file, reason] of held) {
    const { outcome, merges } = await testFilesTick([file]);
    assert.equal(merges, 0, label);
    assert.equal(outcome.failed, "changes_existing_test", label);
    assert.equal(outcome.merge_class?.class, "approve", label);
    assert.match(outcome.merge_class?.reasons[0] ?? "", reason, label);
  }
  const edit = {
    filename: "test/x.test.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
  };
  const approved = await testFilesTick([edit], [approval()]);
  assert.equal(approved.outcome.merged, true, approved.outcome.why ?? "");
});

// A pull request labeled visual waits for Dustin's look, and a draft is never sent to the merge API.

function visualRoutes(body: string) {
  const routes = tickRoutes(DOCS);
  const [pr] = routes[`GET ${OWNER}/pulls`].body;
  return {
    ...routes,
    [`GET ${OWNER}/pulls`]: {
      body: [{ ...pr, title: "New header", body, labels: [{ name: "visual" }] }],
    },
  };
}

test("a visual PR is held for Dustin's look with its preview and screenshots, and his approval merges it", async () => {
  const body =
    "Closes job_4c0ecc28548b.\n\nPreview: https://pr-23.sample.workers.dev/\n\n![after](https://example.com/after.png)";
  const held = await tickWith((await enabledEnv()).env, visualRoutes(body));
  assert.equal(held.merges, 0);
  assert.equal(held.outcome.failed, "visual_awaits_look");
  assert.equal(held.outcome.merge_class?.class, "approve");
  assert.deepEqual(held.outcome.visual, {
    title: "New header",
    preview: "https://pr-23.sample.workers.dev/",
    shots: ["https://example.com/after.png"],
  });

  const approved = withApprovals((await enabledEnv()).env, [approval()]);
  const merged = await tickWith(approved.env, visualRoutes("Closes job_4c0ecc28548b."));
  assert.equal(merged.outcome.merged, true, merged.outcome.why ?? "");
  assert.equal(merged.merges, 1);
});

test("a draft PR the policy would merge is held as class wait and never sent to the merge API", async () => {
  const routes = tickRoutes(DOCS);
  const [pr] = routes[`GET ${OWNER}/pulls`].body;
  const drafted = {
    ...routes,
    [`GET ${OWNER}/pulls`]: { body: [{ ...pr, draft: true }] },
  };
  const { outcome, merges } = await tickWith((await enabledEnv()).env, drafted);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "pr_is_draft");
  assert.equal(outcome.merge_class?.class, "wait");
});
