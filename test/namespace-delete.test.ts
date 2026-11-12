import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteRefusals,
  fingerprintDifference,
  NAMESPACE_DELETE_MAX_DOCUMENTS,
  planFingerprint,
  type DeletePlan,
  type PlanCounts,
} from "../src/namespace-delete.ts";
import { confirmKeys } from "../src/auth.ts";
import { D1_BATCH_STATEMENTS } from "../src/limits.ts";
import { actionArgFor, defaultActionFor, requiredGrant } from "../src/scope.ts";
import { hintsFor } from "../src/tool-annotations.ts";
import { MANAGE_NAMESPACES } from "../src/tools/surface.ts";

// The pure half of capsid_admin_manage_namespaces's delete_preview and delete_perform
// (the delete_namespace operation): the refusals, the plan fingerprint and the
// confirmation key. The store half is test-integration/delete-namespace.test.ts,
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
    agents_live: 0,
    agents_revoked: 0,
    policy_documents: 0,
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
    policy_paths: [],
    live_paths: [],
    live_paths_sha256: "0".repeat(64),
    ...over,
  };
}

const NONE = { cascade: false, allowImprovePaths: false };
const ALL = { cascade: true, allowImprovePaths: true };

test("the tool is admin, destructive, and its action argument is required with no default", () => {
  // Delete is two actions of capsid_admin_manage_namespaces (delete_preview,
  // delete_perform). The tool also registers and updates, so it carries one set of
  // hints for all four: not idempotent, because a register is not.
  assert.equal(requiredGrant("capsid_admin_manage_namespaces"), "admin");
  assert.deepEqual(hintsFor("capsid_admin_manage_namespaces"), {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.equal(actionArgFor("capsid_admin_manage_namespaces"), "action");
  assert.equal(
    defaultActionFor("capsid_admin_manage_namespaces"),
    undefined,
    "an omitted action must never mean perform",
  );
  assert.equal(
    MANAGE_NAMESPACES.defaultAction,
    undefined,
    "the served schema gives the action a default, so an omitted one could mean perform",
  );
  assert.deepEqual(MANAGE_NAMESPACES.actions.delete_perform.inject, { action: "perform" });
  assert.deepEqual(MANAGE_NAMESPACES.actions.delete_preview.inject, { action: "preview" });
});

test("an empty registered namespace has no refusal", () => {
  assert.deepEqual(deleteRefusals(plan(), NONE), []);
});

test("an unregistered namespace is the only refusal", () => {
  const refusals = deleteRefusals(
    plan({ registered: false, on_roster: true }, { jobs_open: 3 }),
    ALL,
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /namespace not found: sample/);
});

test("PLANT: an open job refuses whatever cascade and allow_improve_paths say, and names the job", () => {
  const p = plan(
    { open_jobs: [{ id: "job_000000000001", status: "blocked", title: "t" }] },
    { jobs_open: 1 },
  );
  const refusals = deleteRefusals(p, ALL);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /job_000000000001 \(blocked, 't'\)/);
  assert.match(refusals[0], /supersede/);
  assert.match(refusals[0], /cascade never reaches jobs/);
});

test("PLANT: a live agent refuses whatever cascade says, and names the agent", () => {
  const refusals = deleteRefusals(
    plan({ live_agents: ["sample-driver"] }, { agents_live: 1 }),
    ALL,
  );
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

test("PLANT: a signed policy document needs allow_improve_paths", () => {
  const p = plan(
    { policy_paths: ["policy/auto-merge.md"] },
    { documents_live: 1, policy_documents: 1 },
  );
  const refusals = deleteRefusals(p, { cascade: true, allowImprovePaths: false });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /policy\/auto-merge\.md/);
  assert.deepEqual(deleteRefusals(p, ALL), []);
});

test("PLANT: a roster namespace is refused whatever the arguments", () => {
  const refusals = deleteRefusals(plan({ on_roster: true }), ALL);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /roster/);
});

test("a refusal names at most twenty and counts the rest", () => {
  const ids = Array.from({ length: 20 }, (_, i) => ({
    id: `job_${String(i).padStart(12, "0")}`,
    status: "queued",
    title: "t",
  }));
  const refusal = deleteRefusals(plan({ open_jobs: ids }, { jobs_open: 25 }), NONE)[0];
  assert.match(refusal, /and 5 more/);
});

test("the fingerprint ignores key order and moves with every count", () => {
  const a = plan({ jobs_by_status: { done: 1, failed: 2 } });
  const b = plan({ jobs_by_status: { failed: 2, done: 1 } });
  assert.equal(planFingerprint(a), planFingerprint(b));
  for (const key of Object.keys(zeroCounts()) as Array<keyof PlanCounts>) {
    const moved = plan({}, { [key]: 1 });
    assert.notEqual(
      planFingerprint(moved),
      planFingerprint(plan()),
      `${key} does not move the fingerprint`,
    );
  }
  assert.notEqual(
    planFingerprint(plan({ ops_site_revision: 2 })),
    planFingerprint(plan({ ops_site_revision: 3 })),
  );
  assert.notEqual(
    planFingerprint(plan({ live_paths_sha256: "1".repeat(64) })),
    planFingerprint(plan()),
    "a swapped document would not move the fingerprint",
  );
});

// the batch cap

test("the cap is derived from D1's batch ceiling: six fixed statements plus two per document", () => {
  assert.equal(D1_BATCH_STATEMENTS, 100);
  assert.equal(NAMESPACE_DELETE_MAX_DOCUMENTS, Math.floor((D1_BATCH_STATEMENTS - 6) / 2));
  assert.equal(NAMESPACE_DELETE_MAX_DOCUMENTS, 47);
  assert.ok(
    6 + 2 * NAMESPACE_DELETE_MAX_DOCUMENTS <= D1_BATCH_STATEMENTS,
    "a batch at the cap does not fit",
  );
  assert.ok(
    6 + 2 * (NAMESPACE_DELETE_MAX_DOCUMENTS + 1) > D1_BATCH_STATEMENTS,
    "the cap is lower than it needs to be",
  );
});

test("PLANT: one document over the cap is refused whatever cascade says, with the count, the cap and the advice", () => {
  const over = deleteRefusals(
    plan({}, { documents_live: NAMESPACE_DELETE_MAX_DOCUMENTS + 1 }),
    ALL,
  );
  assert.equal(over.length, 1);
  assert.match(over[0], new RegExp(`holds ${NAMESPACE_DELETE_MAX_DOCUMENTS + 1} live documents`));
  assert.match(over[0], new RegExp(`at most ${NAMESPACE_DELETE_MAX_DOCUMENTS}`));
  assert.match(
    over[0],
    /delete documents with capsid_delete_doc, or move them with capsid_write_doc action move, first, or ask the seat to rule a set-based helper/i,
  );
  assert.deepEqual(
    deleteRefusals(plan({}, { documents_live: NAMESPACE_DELETE_MAX_DOCUMENTS }), ALL),
    [],
    "exactly the cap is refused",
  );
});

test("the difference names what moved", () => {
  const diff = fingerprintDifference(
    planFingerprint(plan({}, { documents_live: 1 })),
    planFingerprint(plan({ ops_site_revision: 2 }, { documents_live: 2 })),
  );
  assert.deepEqual(diff, ["counts.documents_live 1 -> 2", "ops_site_revision null -> 2"]);
});

// ---- the token -------------------------------------------------------------------
// The token itself is site-runtime's ./confirm-token, tested where it lives; the key is Capsid's.

test("with no root secret nothing is signed or checked", async () => {
  await assert.rejects(
    () => confirmKeys({ COOKIE_ENCRYPTION_KEY: "" }, "capsid-namespace-delete:v1"),
    /COOKIE_ENCRYPTION_KEY is unset/,
  );
});
