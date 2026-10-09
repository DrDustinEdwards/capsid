import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { legacyAgent } from "../src/agents.ts";
import { claimJob, postJob } from "../src/jobs.ts";
import { readModelLearning } from "../src/model-learning.ts";
import {
  DELETION_LINES_HIGH,
  JOB_KINDS,
  MIN_SAMPLE,
  MODELS,
  ROUTING_RULES,
  WATCHER_ACTOR_NAME,
  cellsOf,
  deriveKind,
  modelAlias,
  proposeRuleChanges,
  riskFromJob,
  riskOf,
  worthReviewer,
  routeJob,
  type OutcomeFact,
} from "../src/model-routing.ts";
import { WATCHER_ACTOR } from "../src/watcher.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// Automatic model routing (src/model-routing.ts, docs/work-queue.md). The titles below are
// real ones from the capsid queue, so the kind rules are held to the work they will read.

const DRIVER = "agent:capsid-driver";
const job = (title: string, over: Record<string, unknown> = {}) => ({ title, namespace: "capsid", posted_by: "access:seat@example.com", ...over });

// KIND

test("deriveKind reads real queue titles, the watcher by its actor, and a given kind first", () => {
  const expected: Array<[string, string]> = [
    ["Re-pin git dependencies to the rewritten history (capsomer in the dashboard lockfile), and redeploy capsid", "maintenance"],
    ["Build D6.2: Capsid defines the health format and the watcher reads it from every site, headers included", "build"],
    ["Design only: the Portal as the place admin work gets done (gaps, decisions inbox, your-steps inbox, run in cloud, live checks)", "design"],
    ["Design: shared test helpers, shared contract suites and one reusable CI workflow (test once, where code lives)", "design"],
    ["Build D3.3: capsid verifies the Access JWT with jose and deletes its hand-rolled verifier", "security"],
    ["Security hardening from the OWASP agentic mapping: provenance tags, canon write-protection, circuit breaker", "security"],
    ["Watcher: the deployed sha is not master head [deploy-drift-5429141]", "watcher"],
    ["Build D2.6: capsid weekly restore rehearsal runs the d1-dump drill", "build"],
    ["Fix the typo in the quickstart", "mechanical"],
    ["Portal insight build on Capsomer: sessions, estimates, usage, credentials, domains, changelog", "other"],
  ];
  for (const [title, kind] of expected) assert.equal(deriveKind(job(title)).kind, kind, title);
  assert.equal(deriveKind(job("Anything at all", { posted_by: WATCHER_ACTOR })).kind, "watcher");
  assert.deepEqual(deriveKind(job("Build X", { kind: "docs" })), { kind: "docs", source: "given" });
  assert.equal(deriveKind(job("Build X", { kind: "not-a-kind" })).kind, "build", "an unknown kind is ignored, not stored");
  assert.ok(expected.length === 10, "the table read ten titles");
});

test("the watcher's actor here is the watcher's actor there", () => {
  assert.equal(WATCHER_ACTOR_NAME, WATCHER_ACTOR);
});

// ROUTING

test("the expected model for each kind, and the default for a kind no rule names", () => {
  const want: Record<string, [string, string]> = {
    design: ["opus", "high"],
    security: ["opus", "high"],
    build: ["opusplan", "high"],
    watcher: ["sonnet", "medium"],
    maintenance: ["sonnet", "medium"],
    docs: ["sonnet", "low"],
    mechanical: ["haiku", "low"],
    other: ["opusplan", "medium"],
  };
  assert.deepEqual(Object.keys(want).sort(), [...JOB_KINDS].sort(), "a kind has no expectation here");
  for (const kind of JOB_KINDS) {
    const r = routeJob(job("x", { kind }));
    assert.deepEqual([r.model, r.effort], want[kind], kind);
  }
});

test("PLANT: a routine job that is risky is upgraded to opus, whatever its kind", () => {
  const routine = routeJob(job("Update the changelog", { kind: "docs" }));
  assert.equal(routine.model, "sonnet");
  assert.equal(routeJob(job("Update the changelog", { kind: "docs", required_flags: ["money_paths"] })).model, "opus");
  assert.equal(routeJob(job("Update the changelog", { kind: "docs", gate_required: true })).model, "opus");
  assert.equal(routeJob(job("Update the changelog", { kind: "docs", namespace: "foxhound" })).model, "opus");
  const upgraded = routeJob(job("Update the changelog", { kind: "docs", required_flags: ["can_merge"] }));
  assert.match(upgraded.reason, /requires can_merge/);
  assert.equal(upgraded.risk, "high");
  // A flag that asks for no blast radius does not upgrade.
  assert.equal(routeJob(job("Update the changelog", { kind: "docs", required_flags: ["can_comment_pr"] })).model, "sonnet");
});

test("a pull request's files can raise a job's risk and never lower it", () => {
  const risky = riskOf([{ filename: "src/billing/refunds.ts" }]);
  assert.equal(routeJob(job("Tidy", { kind: "maintenance", pr_risk: risky })).model, "opus");
  const routine = riskOf([{ filename: "docs/x.md" }]);
  assert.equal(routeJob(job("Tidy", { kind: "maintenance", pr_risk: routine })).model, "sonnet");
  assert.equal(routeJob(job("Tidy", { kind: "maintenance", required_flags: ["can_merge"], pr_risk: routine })).model, "opus", "a routine PR does not lower a job's own risk");
});

test("a job that names its model is routed there, from a line of its own in the body", () => {
  assert.equal(routeJob(job("Tidy", { kind: "docs", body: "Do it.\nmodel: haiku\nThen stop." })).model, "haiku");
  assert.equal(routeJob(job("Tidy", { kind: "docs", body: "We tried model: haiku before and it was too thin." })).model, "sonnet", "prose that mentions a model names none");
});

test("every kind and the rule list are tied: the last rule is the catch-all, and every rule's model is a known one", () => {
  const last = ROUTING_RULES[ROUTING_RULES.length - 1];
  assert.deepEqual(last?.when, {});
  for (const rule of ROUTING_RULES) assert.ok((MODELS as readonly string[]).includes(rule.model), rule.model);
  for (const kind of JOB_KINDS.filter((k) => k !== "other")) assert.ok(ROUTING_RULES.some((r) => r.when.kind === kind), `no rule names ${kind}`);
});

// RISK

test("riskOf: money paths, refused paths, backups, deletions and renames each raise it, and no files is unread", () => {
  assert.equal(riskOf([{ filename: "docs/readme.md" }]).level, "routine");
  assert.equal(riskOf([{ filename: "app/payments/charge.ts" }]).level, "high");
  assert.match(riskOf([{ filename: "migrations/0099_x.sql" }]).reasons.join(" "), /migration/);
  assert.match(riskOf([{ filename: "src/backup.ts" }]).reasons.join(" "), /backup or restore/);
  assert.match(riskOf([{ filename: "docs/x.md", status: "removed" }]).reasons.join(" "), /is deleted/);
  assert.equal(riskOf([{ filename: "docs/a.md", deletions: DELETION_LINES_HIGH - 1 }]).level, "routine");
  assert.equal(riskOf([{ filename: "docs/a.md", deletions: DELETION_LINES_HIGH }]).level, "high");
  assert.equal(riskOf([{ filename: "docs/b.md", previous_filename: "src/scope.ts" }]).level, "high", "a rename is judged under both names");
  const none = riskOf([]);
  assert.deepEqual([none.level, none.files_read], ["unread", 0], "no files read is not routine");
  assert.equal(riskOf([{ filename: "a.md" }, { filename: "b.md" }]).files_read, 2, "the count of files read is carried");
});

// WORTH A REVIEWER

const worth = (files: Parameters<typeof worthReviewer>[0]) => worthReviewer(files).level;

test("worthReviewer: what riskOf flags for routing but a reviewer would not read is skipped", () => {
  // Each of these is high for riskOf (the measured noise): a dependency bump, a backup
  // document, a deleted screenshot, a large prose deletion, a tsconfig edit.
  for (const files of [
    [{ filename: "package-lock.json" }, { filename: "package.json" }],
    [{ filename: "docs/backups.md" }],
    [{ filename: "docs/img/portal.png", status: "removed" }],
    [{ filename: "docs/old-plan.md", deletions: DELETION_LINES_HIGH + 50 }],
    [{ filename: "tsconfig.test.json" }],
    [{ filename: "test/restore-drill.test.ts" }, { filename: "test-integration/backup.test.ts" }],
    [{ filename: "dashboard/src/views/Backups.tsx" }],
  ]) {
    const names = files.map((f) => f.filename).join(", ");
    assert.equal(riskOf(files).level, "high", `riskOf no longer flags ${names}, so this case shows nothing`);
    assert.equal(worth(files), "skip", names);
  }
  // Ordinary code that enforces nothing is skipped by both.
  assert.equal(worth([{ filename: "dashboard/src/styles.css" }, { filename: "src/limits.ts" }]), "skip");
});

test("worthReviewer: money, judges, guards, migrations, workflows and backup code are each worth a reviewer", () => {
  const cases: Array<[string, RegExp]> = [
    ["app/payments/charge.ts", /billing or payment code/],
    ["src/scope.ts", /isMoneyPath/],
    ["src/auto-merge-policy.ts", /auto-merge source/],
    ["src/jobs-transition.ts", /job transitions/],
    ["scripts/check-commit-trailers.mjs", /check script/],
    ["migrations/0040_x.sql", /migration/],
    [".github/workflows/ci.yml", /workflow, which holds CI's permissions/],
    ["src/store-guards.ts", /snapshot and audit guard/],
    ["src/tools/repo.ts", /guardedWrite/],
    ["src/tools/docs.ts", /pathMutation/],
    ["src/portal-auth.ts", /login or session check/],
    ["src/runner-key.ts", /key or a signature/],
    ["src/agents-admin.ts", /agent credentials/],
    ["src/backup.ts", /backup or restore code/],
    ["scripts/restore-table.mjs", /backup or restore code/],
  ];
  for (const [filename, why] of cases) {
    const verdict = worthReviewer([{ filename: "docs/notes.md" }, { filename }]);
    assert.equal(verdict.level, "worth", filename);
    assert.match(verdict.reasons.join(" "), why, filename);
  }
});

test("worthReviewer: a rename is judged under both names, and no files is unread, never skip", () => {
  assert.equal(worth([{ filename: "src/old-scope.ts", previous_filename: "src/scope.ts" }]), "worth");
  const none = worthReviewer([]);
  assert.deepEqual([none.level, none.files_read], ["unread", 0]);
  assert.equal(worthReviewer([{ filename: "a.md" }, { filename: "b.md" }]).files_read, 2);
});

test("worthReviewer: a test or a document named like a guard is not the guard", () => {
  for (const filename of ["test/scope.test.ts", "docs/store-guards.md", "test/fixtures/migrations/0001.sql", "src/agents-schema.ts", "src/tools/docs-index.ts"]) {
    assert.equal(worth([{ filename }]), "skip", filename);
  }
});

test("worthReviewer reaches past riskOf only through the guard sources", () => {
  // Every other reason is one riskOf also gives. The guard sources are not on auto-merge's
  // refused list, so riskOf routes them as routine; a reviewer reading them is the point.
  for (const filename of [
    "app/payments/charge.ts", "src/scope.ts", "migrations/0040_x.sql", ".github/workflows/ci.yml", "src/backup.ts",
    "scripts/check-commit-trailers.mjs", "src/jobs-transition.ts",
  ]) {
    assert.equal(riskOf([{ filename }]).level, "high", filename);
  }
  for (const filename of ["src/store-guards.ts", "src/tools/repo.ts", "src/portal-auth.ts", "src/runner-key.ts"]) {
    assert.deepEqual([riskOf([{ filename }]).level, worth([{ filename }])], ["routine", "worth"], filename);
  }
});

test("riskFromJob: only blast-radius flags, a gate, or a payments namespace make a job high", () => {
  assert.equal(riskFromJob({ namespace: "capsid" }).level, "routine");
  assert.equal(riskFromJob({ namespace: "capsid", required_flags: ["can_comment_pr"] }).level, "routine");
  assert.equal(riskFromJob({ namespace: "capsid", required_flags: ["can_write_workflows"] }).level, "high");
  assert.equal(riskFromJob({ namespace: "foxhound" }).level, "high");
});

// LEARNING

const fact = (kind: string, model: string, good: boolean, over: Partial<OutcomeFact> = {}): OutcomeFact => ({
  kind,
  model,
  prs_merged: good ? 1 : 0,
  ci_green: good ? 1 : 0,
  corrections: 0,
  cost_usd: null,
  tokens: null,
  ...over,
});
const many = (n: number, good: number, kind: string, model: string) => Array.from({ length: n }, (_, i) => fact(kind, model, i < good));

test("modelAlias reduces a reported model id to its alias and keeps an unknown one as reported", () => {
  assert.equal(modelAlias("claude-opus-5-5"), "opus");
  assert.equal(modelAlias("claude-sonnet-5-5"), "sonnet");
  assert.equal(modelAlias("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(modelAlias("opusplan"), "opusplan");
  assert.equal(modelAlias("claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(modelAlias(null), null);
});

test("cellsOf counts per kind and model, skips outcomes with no kind or model, and marks a thin cell", () => {
  const cells = cellsOf([...many(MIN_SAMPLE, 8, "docs", "sonnet"), fact("docs", "haiku", true), fact("", "opus", true), fact("docs", "", true), { ...fact("docs", "sonnet", true), kind: null }]);
  assert.equal(cells.length, 2);
  const sonnet = cells.find((c) => c.model === "sonnet");
  assert.deepEqual([sonnet?.n, sonnet?.merged_green, sonnet?.rate, sonnet?.enough], [MIN_SAMPLE, 8, 0.8, true]);
  const haiku = cells.find((c) => c.model === "haiku");
  assert.deepEqual([haiku?.n, haiku?.enough], [1, false], "one outcome is shown and never acted on");
  assert.equal(cells.reduce((s, c) => s + c.n, 0), MIN_SAMPLE + 1, "the count of outcomes read is the sum of the cells");
});

test("proposals: a cheaper model that did as well is proposed; a stronger one when the current is under the floor; nothing below the minimum sample", () => {
  // docs is on sonnet; haiku matched it over enough outcomes.
  const cheaper = proposeRuleChanges(cellsOf([...many(12, 10, "docs", "sonnet"), ...many(12, 10, "docs", "haiku")]));
  assert.deepEqual(cheaper.map((p) => [p.kind, p.from, p.to]), [["docs", "sonnet", "haiku"]]);
  // maintenance is on sonnet; it merges green half the time and opus does much better.
  const stronger = proposeRuleChanges(cellsOf([...many(12, 5, "maintenance", "sonnet"), ...many(12, 11, "maintenance", "opus")]));
  assert.deepEqual(stronger.map((p) => [p.kind, p.from, p.to]), [["maintenance", "sonnet", "opus"]]);
  // The same shape on too few outcomes proposes nothing: a rate over a small denominator is noise.
  assert.deepEqual(proposeRuleChanges(cellsOf([...many(MIN_SAMPLE - 1, 10, "docs", "sonnet"), ...many(MIN_SAMPLE - 1, 10, "docs", "haiku")])), []);
  // A cheaper model that did worse is not proposed, and a current rate above the floor does not move.
  assert.deepEqual(proposeRuleChanges(cellsOf([...many(12, 11, "docs", "sonnet"), ...many(12, 4, "docs", "haiku")])), []);
  assert.deepEqual(proposeRuleChanges(cellsOf([...many(12, 9, "maintenance", "sonnet"), ...many(12, 12, "maintenance", "opus")])), []);
});

test("readModelLearning reads the window, states what it read, and proposes nothing from no evidence", async () => {
  const rows = [...many(12, 10, "docs", "sonnet"), ...many(12, 10, "docs", "haiku")];
  let sql = "";
  let bound: unknown[] = [];
  const db = {
    prepare: (text: string) => {
      sql = text;
      return { bind: (...args: unknown[]) => ((bound = args), { all: async () => ({ results: rows }) }) };
    },
  } as unknown as D1Database;
  const out = await readModelLearning(db, new Date("2026-10-06T12:00:00Z"));
  assert.equal(out.outcomes_read, 24);
  assert.equal(out.proposals.length, 1);
  assert.match(out.note, /none applied/);
  assert.match(sql, /o\.job_kind IS NOT NULL/);
  assert.match(String(bound[0]), /^2026-07-08/, "the window starts 90 days back");
  const empty = await readModelLearning({ prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } as unknown as D1Database, new Date());
  assert.deepEqual([empty.outcomes_read, empty.proposals.length], [0, 0]);
  assert.match(empty.note, /No routed outcome/);
});

// THE QUEUE: post assigns, claim delivers

test("post assigns the kind and model at the Worker, and a given kind is validated", async () => {
  const d1 = fakeD1({});
  const env = fakeEnv({ DB: d1.db, IMPROVE_SCORE_SECRET: "test-secret" });
  const agent = legacyAgent("write", DRIVER);
  const now = new Date("2026-10-06T12:00:00Z");
  const posted = await postJob(env, agent, now, { namespace: "capsid", title: "Design: the thing", body: "think" });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.deepEqual([posted.job?.kind, posted.job?.model_recommended, posted.job?.effort_recommended], ["design", "opus", "high"]);
  assert.match(posted.job?.routing_reason ?? "", /design/);
  const insert = d1.recorded.find((r) => /INSERT INTO jobs \(/.test(r.sql));
  assert.ok(insert && /model_recommended/.test(insert.sql), "the insert did not name the routing columns");
  assert.ok(insert.params.includes("opus"), "the model was not bound");

  const risky = await postJob(env, agent, now, { namespace: "capsid", title: "Update the changelog", body: "x", kind: "docs", required_scopes: { flags: ["can_merge"] } });
  assert.equal(risky.job?.model_recommended, "opus", "a risky routine job was posted on the cheap model");

  const bad = await postJob(env, agent, now, { namespace: "capsid", title: "Another", body: "x", kind: "nonsense" });
  assert.equal(bad.ok, false);
  assert.match(bad.refusal ?? "", /not a job kind/);
});

test("claim returns the recommendation with how to follow it, and routes a job posted before routing existed", async () => {
  const d1 = fakeD1({});
  const env = fakeEnv({ DB: d1.db, IMPROVE_SCORE_SECRET: "test-secret" });
  const agent = legacyAgent("write", DRIVER);
  const now = new Date("2026-10-06T12:00:00Z");
  const posted = await postJob(env, agent, now, { namespace: "capsid", title: "Build D9: a thing", body: "do it" });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  // The state of a row written before migration 0032: no routing columns set.
  const stored = d1.rows.jobs.find((j) => j.id === posted.job?.id);
  assert.ok(stored, "the posted job is not in the fake");
  for (const column of ["kind", "model_recommended", "effort_recommended", "routing_reason"]) stored[column] = null;

  const claimed = await claimJob(env, agent, now, { id: posted.job?.id });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.deepEqual(
    [claimed.routing?.model, claimed.routing?.effort, claimed.routing?.kind],
    ["opusplan", "high", "build"]
  );
  assert.match(String(claimed.routing?.deliver), /--model opusplan/);
  assert.match(String(claimed.routing?.deliver), /subagent/);
  assert.equal(claimed.job?.model_recommended, "opusplan");
  const update = d1.recorded.find((r) => /UPDATE jobs SET status = 'claimed'/.test(r.sql));
  assert.ok(update?.params.includes("opusplan"), "the claim did not record the model it recommended");
});

// THE WIRING THE TESTS CANNOT SEE FROM INSIDE ONE FILE

test("the migration adds exactly the columns the code reads and writes", () => {
  const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0032_job_model_routing.sql"), "utf8");
  const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map((m) => `${m[1]}.${m[2]}`).sort();
  assert.deepEqual(added, [
    "job_outcomes.job_kind",
    "job_outcomes.model_actual",
    "job_outcomes.model_chosen",
    "jobs.effort_recommended",
    "jobs.kind",
    "jobs.model_recommended",
    "jobs.routing_reason",
  ]);
});
