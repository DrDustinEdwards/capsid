import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorKey, bestKey, driverKey, pausedKey } from "../src/improve-schema.ts";
import {
  deleteRefusals,
  fingerprintDifference,
  improveKvKeys,
  NAMESPACE_DELETE_MAX_DOCUMENTS,
  planFingerprint,
  signDeleteToken,
  verifyDeleteToken,
  type DeleteClaims,
  type DeletePlan,
  type PlanCounts,
} from "../src/namespace-delete.ts";
import { D1_BATCH_STATEMENTS } from "../src/limits.ts";
import { actionArgFor, defaultActionFor, requiredGrant } from "../src/scope.ts";
import { hintsFor } from "../src/tool-annotations.ts";

// The pure half of delete_namespace: the refusals, the plan fingerprint and the
// confirmation token. The store half is test-integration/delete-namespace.test.ts,
// against a real D1, because the batch is INSERT ... SELECT and json_each the node fake
// does not evaluate.

function zeroCounts(): PlanCounts {
  return {
    documents_live: 0,
    documents_archived: 0,
    document_versions: 0,
    audit_log: 0,
    document_links_removed: 0,
    jobs_open: 0,
    jobs_finished: 0,
    job_outcomes: 0,
    job_claims: 0,
    job_touches: 0,
    skill_evaluations: 0,
    skill_failures: 0,
    improve_runs: 0,
    improve_attempts: 0,
    improve_scores: 0,
    improve_skills: 0,
    improve_jti: 0,
    agents_live: 0,
    agents_revoked: 0,
    improve_control_documents: 0,
  };
}

function plan(over: Partial<DeletePlan> = {}, counts: Partial<PlanCounts> = {}): DeletePlan {
  return {
    namespace: "sample",
    registered: true,
    on_roster: false,
    counts: { ...zeroCounts(), ...counts },
    jobs_by_status: {},
    ops_site: null,
    ops_site_revision: null,
    open_jobs: [],
    live_agents: [],
    improve_control_paths: [],
    kv_keys: [],
    live_paths: [],
    live_paths_sha256: "0".repeat(64),
    ...over,
  };
}

const NONE = { cascade: false, allowImprovePaths: false };
const ALL = { cascade: true, allowImprovePaths: true };

test("the tool is admin, destructive, and its action argument is required with no default", () => {
  assert.equal(requiredGrant("delete_namespace"), "admin");
  assert.deepEqual(hintsFor("delete_namespace"), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.equal(actionArgFor("delete_namespace"), "action");
  assert.equal(defaultActionFor("delete_namespace"), undefined, "an omitted action must never mean perform");
});

test("an empty registered namespace has no refusal", () => {
  assert.deepEqual(deleteRefusals(plan(), NONE), []);
});

test("an unregistered namespace is the only refusal", () => {
  const refusals = deleteRefusals(plan({ registered: false, on_roster: true }, { jobs_open: 3 }), ALL);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /namespace not found: sample/);
});

test("PLANT: an open job refuses whatever cascade and allow_improve_paths say, and names the job", () => {
  const p = plan({ open_jobs: [{ id: "job_000000000001", status: "blocked", title: "t" }] }, { jobs_open: 1 });
  const refusals = deleteRefusals(p, ALL);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /job_000000000001 \(blocked, 't'\)/);
  assert.match(refusals[0], /supersede/);
  assert.match(refusals[0], /cascade never reaches jobs/);
});

test("PLANT: a live agent refuses whatever cascade says, and names the agent", () => {
  const refusals = deleteRefusals(plan({ live_agents: ["sample-driver"] }, { agents_live: 1 }), ALL);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /sample-driver/);
  assert.match(refusals[0], /revoke/);
  assert.match(refusals[0], /update_scopes/);
});

test("a revoked agent is history and refuses nothing", () => {
  assert.deepEqual(deleteRefusals(plan({}, { agents_revoked: 2 }), NONE), []);
});

test("PLANT: live documents refuse without cascade, and cascade clears exactly that refusal", () => {
  const p = plan({}, { documents_live: 4, documents_archived: 9 });
  assert.equal(deleteRefusals(p, NONE).length, 1);
  assert.match(deleteRefusals(p, NONE)[0], /4 live documents/);
  assert.deepEqual(deleteRefusals(p, { cascade: true, allowImprovePaths: false }), []);
});

test("archived documents alone need no cascade", () => {
  assert.deepEqual(deleteRefusals(plan({}, { documents_archived: 9 }), NONE), []);
});

test("PLANT: an improve control document needs allow_improve_paths", () => {
  const p = plan({ improve_control_paths: ["improve/prompts/run.md"] }, { documents_live: 1, improve_control_documents: 1 });
  const refusals = deleteRefusals(p, { cascade: true, allowImprovePaths: false });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /improve\/prompts\/run\.md/);
  assert.deepEqual(deleteRefusals(p, ALL), []);
});

test("PLANT: a roster namespace is refused whatever the arguments", () => {
  const refusals = deleteRefusals(plan({ on_roster: true }), ALL);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /roster/);
});

test("a refusal names at most twenty and counts the rest", () => {
  const ids = Array.from({ length: 20 }, (_, i) => ({ id: `job_${String(i).padStart(12, "0")}`, status: "queued", title: "t" }));
  const refusal = deleteRefusals(plan({ open_jobs: ids }, { jobs_open: 25 }), NONE)[0];
  assert.match(refusal, /and 5 more/);
});

test("the fingerprint ignores key order and KV key order, and moves with every count", () => {
  const a = plan({ kv_keys: ["b", "a"], jobs_by_status: { done: 1, failed: 2 } });
  const b = plan({ kv_keys: ["a", "b"], jobs_by_status: { failed: 2, done: 1 } });
  assert.equal(planFingerprint(a), planFingerprint(b));
  for (const key of Object.keys(zeroCounts()) as Array<keyof PlanCounts>) {
    const moved = plan({}, { [key]: 1 });
    assert.notEqual(planFingerprint(moved), planFingerprint(plan()), `${key} does not move the fingerprint`);
  }
  assert.notEqual(planFingerprint(plan({ ops_site_revision: 2 })), planFingerprint(plan({ ops_site_revision: 3 })));
  assert.notEqual(planFingerprint(plan({ kv_keys: ["a"] })), planFingerprint(plan()));
  assert.notEqual(planFingerprint(plan({ live_paths_sha256: "1".repeat(64) })), planFingerprint(plan()), "a swapped document would not move the fingerprint");
});

// the batch cap

test("the cap is derived from D1's batch ceiling: five fixed statements plus two per document", () => {
  assert.equal(D1_BATCH_STATEMENTS, 100);
  assert.equal(NAMESPACE_DELETE_MAX_DOCUMENTS, Math.floor((D1_BATCH_STATEMENTS - 5) / 2));
  assert.equal(NAMESPACE_DELETE_MAX_DOCUMENTS, 47);
  assert.ok(5 + 2 * NAMESPACE_DELETE_MAX_DOCUMENTS <= D1_BATCH_STATEMENTS, "a batch at the cap does not fit");
  assert.ok(5 + 2 * (NAMESPACE_DELETE_MAX_DOCUMENTS + 1) > D1_BATCH_STATEMENTS, "the cap is lower than it needs to be");
});

test("PLANT: one document over the cap is refused whatever cascade says, with the count, the cap and the advice", () => {
  const over = deleteRefusals(plan({}, { documents_live: NAMESPACE_DELETE_MAX_DOCUMENTS + 1 }), ALL);
  assert.equal(over.length, 1);
  assert.match(over[0], new RegExp(`holds ${NAMESPACE_DELETE_MAX_DOCUMENTS + 1} live documents`));
  assert.match(over[0], new RegExp(`at most ${NAMESPACE_DELETE_MAX_DOCUMENTS}`));
  assert.match(over[0], /delete or move documents with the delete tool first, or ask the seat to rule a set-based helper/i);
  assert.deepEqual(deleteRefusals(plan({}, { documents_live: NAMESPACE_DELETE_MAX_DOCUMENTS }), ALL), [], "exactly the cap is refused");
});

test("the difference names what moved", () => {
  const diff = fingerprintDifference(planFingerprint(plan({}, { documents_live: 1 })), planFingerprint(plan({ ops_site_revision: 2 }, { documents_live: 2 })));
  assert.deepEqual(diff, ["counts.documents_live 1 -> 2", "ops_site_revision null -> 2"]);
});

test("the KV keys are the four per-namespace improve keys, spelled by improve-schema", () => {
  assert.deepEqual(improveKvKeys("sample"), [bestKey("sample"), pausedKey("sample"), anchorKey("sample"), driverKey("sample")]);
});

// ---- the token -------------------------------------------------------------------

const KEY = { COOKIE_ENCRYPTION_KEY: "unit-namespace-delete-key" };
const NOW = new Date("2026-09-29T12:00:00Z");
const EXPECT = { actor: "access:admin@example.com", namespace: "sample", cascade: true, allowImprovePaths: false };

function claims(over: Partial<DeleteClaims> = {}): DeleteClaims {
  return {
    v: 1,
    namespace: "sample",
    cascade: true,
    allow_improve_paths: false,
    actor: "access:admin@example.com",
    plan: planFingerprint(plan()),
    exp: Math.floor(NOW.getTime() / 1000) + 300,
    ...over,
  };
}

test("a token verifies for the caller and the arguments it was signed for", async () => {
  const verified = await verifyDeleteToken(KEY, await signDeleteToken(KEY, claims()), EXPECT, NOW);
  assert.equal(verified.ok, true);
  assert.equal(verified.ok && verified.claims.plan, planFingerprint(plan()));
});

test("PLANT: every mismatch refuses the token", async () => {
  const cases: Array<[string, Promise<string>, typeof EXPECT, RegExp]> = [
    ["another key", signDeleteToken({ COOKIE_ENCRYPTION_KEY: "other" }, claims()), EXPECT, /does not verify/],
    ["another caller", signDeleteToken(KEY, claims({ actor: "agent:sample-driver" })), EXPECT, /another caller/],
    ["expired", signDeleteToken(KEY, claims({ exp: Math.floor(NOW.getTime() / 1000) })), EXPECT, /expired/],
    ["another namespace", signDeleteToken(KEY, claims({ namespace: "other" })), EXPECT, /issued for namespace other/],
    ["another cascade", signDeleteToken(KEY, claims({ cascade: false })), EXPECT, /issued with cascade false/],
    ["another allow_improve_paths", signDeleteToken(KEY, claims({ allow_improve_paths: true })), EXPECT, /allow_improve_paths true/],
  ];
  for (const [label, token, expect, pattern] of cases) {
    const verified = await verifyDeleteToken(KEY, await token, expect, NOW);
    assert.equal(verified.ok, false, `${label} verified`);
    assert.match(verified.ok ? "" : verified.refusal, pattern, label);
  }
});

test("PLANT: a tampered payload or a malformed token is refused", async () => {
  const token = await signDeleteToken(KEY, claims());
  const [payload, sig] = token.split(".");
  const swapped = Buffer.from(JSON.stringify({ ...claims(), namespace: "other" })).toString("base64url");
  const tampered = await verifyDeleteToken(KEY, `${swapped}.${sig}`, EXPECT, NOW);
  assert.equal(tampered.ok, false);
  assert.match(tampered.ok ? "" : tampered.refusal, /does not verify/);
  for (const bad of ["", "x", `${payload}.`, `${payload}.${"0".repeat(63)}`, `${payload}.${sig}.x`]) {
    const verified = await verifyDeleteToken(KEY, bad, EXPECT, NOW);
    assert.equal(verified.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("with no root secret nothing is signed or checked", async () => {
  await assert.rejects(() => signDeleteToken({ COOKIE_ENCRYPTION_KEY: "" }, claims()), /COOKIE_ENCRYPTION_KEY is unset/);
  await assert.rejects(() => verifyDeleteToken({ COOKIE_ENCRYPTION_KEY: "" }, "a.".concat("0".repeat(64)), EXPECT, NOW), /COOKIE_ENCRYPTION_KEY is unset/);
});
