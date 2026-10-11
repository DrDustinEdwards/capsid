import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AUTO_MERGE_POLICY_PATH, AUTO_MERGE_REQUIRED_CI, evaluatePolicy, loadMergePolicy, parseMergePolicy, PROMOTABLE_PATH_CLASSES, type PrFacts } from "../src/auto-merge-policy.ts";
import { policyPin, policyPinKey, signTaskBody, splitSignedTask } from "../src/improve-task.ts";
import { PATH_CLASSES } from "../src/merge-class.ts";
import { judgeUnits, LIFTED_KEY, liftSuspension, SUSPENDED_KEY } from "../src/merge-units.ts";
import { performPolicyChange, planPolicyChange } from "../src/policy-sign.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The merge units in the signed policy (docs/design/design-merge-pipeline.md section 7,
// PR 10; DECIDE 9 of 2026-10-09). Proves: a document naming an unknown class is refused
// at load; a missing typed version is refused. Also: what a promoted unit widens and what
// it never does, and the Undo of a suspension.

const SECRET = "policy-change-test-secret";
const NOW = new Date("2026-10-11T12:00:00.000Z");
const SHIPPED = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8");
const withUnits = (lines: string[]) => `${SHIPPED.trimEnd()}\n\n## Auto units\n\n${lines.join("\n")}\n`;

async function world(body = SHIPPED) {
  const { db, rows } = fakeD1({ documents: [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "Auto-merge policy", body: await signTaskBody(SECRET, body) }] });
  const kv = fakeKv({ seed: { [policyPinKey(AUTO_MERGE_POLICY_PATH)]: JSON.stringify(await policyPin(body)) } });
  return { env: fakeEnv({ DB: db, APP_KV: kv.kv, IMPROVE_SCORE_SECRET: SECRET }), rows, kv };
}
const storedBody = (rows: { documents: Array<{ path: string; body?: string | null }> }) => rows.documents.find((d) => d.path === AUTO_MERGE_POLICY_PATH)!.body!;

// A unit in the document

test("the promotable path classes are merge-class's own, less money, migration and workflow", () => {
  assert.deepEqual([...PROMOTABLE_PATH_CLASSES].sort(), PATH_CLASSES.filter((c) => c !== "money" && c !== "migration" && c !== "workflow").sort());
});

test("the shipped version 7 lists no unit, and a unit under ## Auto units is read", () => {
  const v7 = parseMergePolicy(SHIPPED);
  assert.ok("policy" in v7);
  assert.deepEqual(v7.policy.units, []);
  const listed = parseMergePolicy(withUnits(["- unit `capsid / tests`", "- unit `carrel/src-routine`"]));
  assert.ok("policy" in listed, "error" in listed ? listed.error : "");
  assert.deepEqual(listed.policy.units, ["capsid / tests", "carrel / src-routine"]);
});

test("PLANT: a document naming an unknown class is refused at load", async () => {
  const parsed = parseMergePolicy(withUnits(["- unit `capsid / everything`"]));
  assert.match("error" in parsed ? parsed.error : "", /'everything', which is not a path class this Worker knows/);
  const { env } = await world(withUnits(["- unit `capsid / everything`"]));
  const loaded = await loadMergePolicy(env);
  assert.ok("error" in loaded, "a policy naming an unknown class loaded");
});

test("money, a migration or a workflow is never a unit, and neither is a namespace the policy does not cover", () => {
  for (const cls of ["money", "migration", "workflow"]) {
    const parsed = parseMergePolicy(withUnits([`- unit \`capsid / ${cls}\``]));
    assert.match("error" in parsed ? parsed.error : "", /never promoted to auto/, cls);
  }
  assert.match((parseMergePolicy(withUnits(["- unit `foxhound / docs`"])) as { error: string }).error, /does not cover/);
  assert.match((parseMergePolicy(withUnits(["- unit `capsid / tests`", "- unit `capsid/tests`"])) as { error: string }).error, /twice/);
  assert.match((parseMergePolicy(`${SHIPPED}\n- unit \`capsid / tests\`\n`) as { error: string }).error, /outside the ## Auto units section/);
});

// What a promoted unit widens

const capsidPr = (paths: string[]): PrFacts =>
  ({
    number: 23,
    repo: "DrDustinEdwards/capsid",
    namespace: "capsid",
    baseRef: "master",
    defaultBranch: "master",
    headSha: "b".repeat(40),
    body: "Closes job_4c0ecc28548b.",
    changedPaths: paths,
    filesProblem: null,
    changedLines: 40,
    ciConclusion: "success",
    ciNote: "green",
    ciSteps: AUTO_MERGE_REQUIRED_CI.capsid!.map((r) => ({ ...r, conclusion: "success" })),
    ciStepsProblem: null,
    headRepo: "DrDustinEdwards/capsid",
    prAuthor: "DrDustinEdwards",
    jobId: "job_4c0ecc28548b",
    jobClaimedBy: "agent:capsid-driver",
    jobStatus: "done",
    jobPrUrls: ["https://github.com/DrDustinEdwards/capsid/pull/23"],
  }) as PrFacts;
const AUTHORS = ["DrDustinEdwards"];

test("a promoted unit lets its namespace's limited paths merge; without it they wait", () => {
  const tests = capsidPr(["test/jobs.test.ts"]);
  const held = evaluatePolicy(tests, AUTHORS);
  assert.equal(held.merge ? null : held.failed, "paths_allowed_for_namespace");
  assert.equal(evaluatePolicy(tests, AUTHORS, { unit: "capsid / tests" }).merge, true);
});

test("a promoted unit never opens a refused path or a money path", () => {
  const refused = evaluatePolicy(capsidPr(["src/jobs.ts"]), AUTHORS, { unit: "capsid / src-worth" });
  assert.equal(refused.merge ? null : refused.failed, "paths_not_refused");
  const money = evaluatePolicy(capsidPr(["src/billing/stripe.ts"]), AUTHORS, { unit: "capsid / src-routine" });
  assert.equal(money.merge, false);
});

// sign_policy_change

test("PLANT: a missing typed version is refused, and nothing is signed or written", async () => {
  const w = await world();
  const before = storedBody(w.rows);
  const refused = await performPolicyChange(w.env, "access:admin@example.com", "promote", "capsid/tests", undefined);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.error : "", /needs the new version number typed as confirm: 8/);
  const wrong = await performPolicyChange(w.env, "access:admin@example.com", "promote", "capsid/tests", "7");
  assert.match(!wrong.ok ? wrong.error : "", /confirm is '7', but the new version is 8/);
  assert.equal(storedBody(w.rows), before, "the policy changed on a refusal");
  assert.equal(w.kv.puts.length, 0, "the pin moved on a refusal");
});

test("typing the new version signs version 8 with the unit, and the Worker loads it", async () => {
  const w = await world();
  const plan = await planPolicyChange(w.env, "promote", "capsid/tests");
  assert.ok(plan.ok, plan.ok ? "" : plan.error);
  assert.deepEqual([plan.from, plan.to, plan.unit], ["7", "8", "capsid / tests"]);
  const done = await performPolicyChange(w.env, "access:admin@example.com", "promote", "capsid/tests", "8");
  assert.ok(done.ok, done.ok ? "" : done.error);
  const { signature, body } = splitSignedTask(storedBody(w.rows));
  assert.ok(signature, "the new version is not signed");
  assert.match(body, /^- version: 8$/m);
  assert.match(body, /## Auto units[\s\S]*- unit `capsid \/ tests`/);
  const loaded = await loadMergePolicy(w.env);
  assert.ok("policy" in loaded, "error" in loaded ? loaded.error : "");
  assert.equal(loaded.policy.version, "8");
  assert.deepEqual(loaded.policy.units, ["capsid / tests"]);
  assert.ok(w.rows.versions.length >= 1, "version 7 was not snapshotted");
  // Removing it is the same control, the next version, the same typed confirm.
  assert.equal((await performPolicyChange(w.env, "access:admin@example.com", "demote", "capsid/tests", "9")).ok, true);
  const v9 = await loadMergePolicy(w.env);
  assert.ok("policy" in v9);
  assert.deepEqual([v9.policy.version, v9.policy.units], ["9", []]);
});

test("a change that would not load, or changes nothing, is refused at the preview", async () => {
  const w = await world();
  assert.match(((await planPolicyChange(w.env, "promote", "capsid/money")) as { error: string }).error, /never promoted to auto/);
  assert.match(((await planPolicyChange(w.env, "demote", "capsid/tests")) as { error: string }).error, /not promoted to auto in version 7/);
  assert.match(((await planPolicyChange(w.env, "widen", "capsid/tests")) as { error: string }).error, /promote or demote/);
  assert.match(((await planPolicyChange(w.env, "promote", "capsid")) as { error: string }).error, /<namespace>\/<path class>/);
});

// unit_resume: the Undo of a suspension

test("lifting a suspension clears it, and only a rollback after the lift suspends the unit again", async () => {
  const kv = fakeKv({ seed: { [SUSPENDED_KEY]: JSON.stringify([{ unit: "capsid/docs", since: "2026-10-10T00:00:00.000Z", reason: "rolled back" }]) } });
  const batches: unknown[] = [];
  const env = fakeEnv({ APP_KV: kv.kv, DB: { prepare: () => ({ bind: () => ({}) }), batch: async (s: unknown[]) => (batches.push(s), []) } });
  const done = await liftSuspension(env, "access:admin@example.com", "capsid/docs", "the fix landed", NOW);
  assert.ok(done.ok);
  assert.deepEqual(JSON.parse(kv.store.get(SUSPENDED_KEY)!), []);
  assert.equal(batches.length, 1, "the lift was not audited");
  const lifted = JSON.parse(kv.store.get(LIFTED_KEY)!) as Record<string, string>;
  const rollback = (runAt: string) => ({ kind: "rollback" as const, namespace: "capsid", repo: "o/capsid", pr: 4, head_sha: "a".repeat(40), run_id: 1, run_at: runAt, merged_by: "tick" as const, path_class: "docs" });
  assert.deepEqual(judgeUnits([], [rollback("2026-10-10T09:00:00.000Z")], [], NOW, lifted).suspended, [], "the answered rollback suspended the unit again");
  assert.deepEqual(judgeUnits([], [rollback("2026-10-11T13:00:00.000Z")], [], new Date("2026-10-11T14:00:00Z"), lifted).suspended.map((s) => s.unit), ["capsid/docs"]);
  assert.equal((await liftSuspension(env, "access:admin@example.com", "capsid/docs", "again", NOW)).ok, false, "a unit not suspended was lifted");
});
