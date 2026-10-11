import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "../src/auto-merge-tick.ts";
import { performApproval, planApproval } from "../src/pr-approvals.ts";
import { fakeKv, withFetch } from "./fakes.ts";

// The approval record (docs/design/design-merge-pipeline.md section 3, PR 3): what
// approve_pr will approve, and what it refuses, from the awaiting-seat set's classes, the
// heads GitHub reports now and the open approvals. The writes against real D1, through the
// Worker's controls, are in test-integration/portal-actions.test.ts.

const ACTOR = "access:admin@example.com";
const CLICK = `portal-approve_pr by ${ACTOR}`;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const NOW = new Date("2026-10-10T12:00:00.000Z");

const awaiting = (number: number, cls: AwaitingSeat["class"], reasons: string[] = []): AwaitingSeat => ({
  namespace: "capsid",
  repo: "owner/repo",
  number,
  failed: "path_class",
  why: "a src change",
  at: NOW.toISOString(),
  class: cls,
  path_class: cls === "typed" ? "money" : "src-routine",
  class_reasons: reasons,
});

interface Recorded {
  sql: string;
  params: unknown[];
}

// D1 for the reads planApproval makes (the namespace's repos, the open approvals) and a
// record of every statement the perform batches.
function db(open: Array<{ id: number; pr: number; head_sha: string }> = []) {
  const recorded: Recorded[] = [];
  const prepare = (sql: string) => {
    const st = {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        st.params = params;
        return st;
      },
      async first() {
        if (/FROM namespaces/.test(sql)) return { repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) };
        return null;
      },
      async all() {
        if (/FROM pr_approvals/.test(sql)) return { results: open, meta: {} };
        return { results: [], meta: {} };
      },
      async run() {
        recorded.push({ sql, params: st.params });
        return { meta: { changes: 1 } };
      },
      sql,
    };
    return st;
  };
  const d1 = {
    prepare,
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      for (const s of statements) recorded.push({ sql: s.sql, params: s.params });
      return statements.map((s) => ({ results: /^UPDATE/.test(s.sql.trim()) ? [{ id: 1 }] : [], meta: { changes: 1 } }));
    },
  };
  return { d1, recorded };
}

function env(set: AwaitingSeat[], open: Array<{ id: number; pr: number; head_sha: string }> = []) {
  const { d1, recorded } = db(open);
  const kv = fakeKv({ seedToken: true, seed: { [AWAITING_SEAT_KEY]: JSON.stringify(set) } }).kv;
  return { env: { DB: d1, APP_KV: kv } as never, recorded };
}

// GitHub's answer for each pull request: open, at the head given.
const pulls = (heads: Record<number, string>, extra: Record<number, object> = {}) =>
  Object.fromEntries(Object.entries(heads).map(([n, sha]) => [`GET /repos/owner/repo/pulls/${n}`, { body: { head: { sha }, state: "open", merged: false, ...extra[Number(n)] } }]));

test("an approve PR at the head that was reviewed is approved, and nothing is merged", async () => {
  const { env: e } = env([awaiting(41, "approve")]);
  await withFetch(pulls({ 41: HEAD_A }), async (calls) => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41", shas: HEAD_A.slice(0, 7) }, "portal", CLICK);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    if (!plan.ok) return;
    assert.deepEqual(plan.targets.map((t) => [t.number, t.head_sha, t.class]), [[41, HEAD_A, "approve"]]);
    assert.deepEqual(plan.audit, [`pr-approved by ${ACTOR}`, CLICK]);
    assert.equal(plan.surface, "portal");
    // A read of the pull request, and never a merge.
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /repos/owner/repo/pulls/41"]);
  });
});

test("PLANT: an approval at sha A with the head now at B is refused: a push since review is not approved", async () => {
  const { env: e } = env([awaiting(41, "approve")]);
  await withFetch(pulls({ 41: HEAD_B }), async () => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41", shas: HEAD_A }, "chat", CLICK);
    assert.equal(plan.ok, false);
    assert.match(!plan.ok ? plan.refusal : "", /#41's head is b{40}, not a{40}: something was pushed since you looked/);
  });
});

test("no sha is refused, naming the head now, so the caller reviews what it approves", async () => {
  const { env: e } = env([awaiting(41, "approve")]);
  await withFetch(pulls({ 41: HEAD_A }), async () => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41" }, "chat", CLICK);
    assert.match(!plan.ok ? plan.refusal : "", new RegExp(`#41 needs the head sha you reviewed .*Its head is ${HEAD_A} now`));
  });
});

test("PLANT: a batch holding one money PR is refused whole, and names it", async () => {
  const { env: e } = env([awaiting(41, "approve"), awaiting(42, "typed")]);
  await withFetch(pulls({ 41: HEAD_A, 42: HEAD_B }), async () => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41,42", shas: `${HEAD_A},${HEAD_B}`, confirm: "42" }, "portal", CLICK);
    assert.equal(plan.ok, false);
    assert.match(!plan.ok ? plan.refusal : "", /#42 touches a money path \(class typed\), which is never batched\. Nothing in the batch was approved/);
  });
});

test("a money PR alone needs its number typed as confirm, and is then recorded as typed", async () => {
  const { env: e } = env([awaiting(42, "typed")]);
  await withFetch(pulls({ 42: HEAD_B }), async () => {
    const without = await planApproval(e, ACTOR, { namespace: "capsid", prs: "42", shas: HEAD_B }, "portal", CLICK);
    assert.match(!without.ok ? without.refusal : "", /type its number as confirm/);
    const wrong = await planApproval(e, ACTOR, { namespace: "capsid", prs: "42", shas: HEAD_B, confirm: "41" }, "portal", CLICK);
    assert.equal(wrong.ok, false);
    const typed = await planApproval(e, ACTOR, { namespace: "capsid", prs: "42", shas: HEAD_B, confirm: "42" }, "portal", CLICK);
    assert.equal(typed.ok, true);
    assert.equal(typed.ok && typed.surface, "typed");
  });
});

test("seat, wait and an unclassed PR are refused, and one of them refuses the batch", async () => {
  const { env: e } = env([awaiting(41, "approve"), awaiting(43, "seat", ["a migration is applied by the seat"]), awaiting(44, "wait", ["CI has not finished"]), awaiting(45, null)]);
  await withFetch(pulls({ 41: HEAD_A, 43: HEAD_A, 44: HEAD_A, 45: HEAD_A, 46: HEAD_A }), async () => {
    for (const [pr, pattern] of [
      ["43", /class seat \(a migration is applied by the seat\)/],
      ["44", /class wait \(CI has not finished\)/],
      ["45", /has no class/],
      ["46", /has no class/],
    ] as const) {
      const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: pr, shas: HEAD_A }, "portal", CLICK);
      assert.match(!plan.ok ? plan.refusal : "", pattern);
    }
    const batch = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41,43", shas: `${HEAD_A},${HEAD_A}` }, "portal", CLICK);
    assert.match(!batch.ok ? batch.refusal : "", /^Nothing in the batch was approved\./);
  });
});

test("a closed or merged PR is refused", async () => {
  const { env: e } = env([awaiting(41, "approve")]);
  await withFetch(pulls({ 41: HEAD_A }, { 41: { state: "closed", merged: true } }), async () => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41", shas: HEAD_A }, "portal", CLICK);
    assert.match(!plan.ok ? plan.refusal : "", /#41 is merged, not open/);
  });
});

test("approving again at a new head voids the open approval and writes both rows in one batch", async () => {
  const { env: e, recorded } = env([awaiting(41, "approve")], [{ id: 7, pr: 41, head_sha: HEAD_A }]);
  await withFetch(pulls({ 41: HEAD_B }), async () => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41", shas: HEAD_B }, "portal", CLICK);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(plan.audit, [`pr-approved by ${ACTOR}`, `pr-approval-voided by ${ACTOR}`, CLICK]);
    const summary = await performApproval(e, ACTOR, plan, "reviewed the diff", NOW);
    assert.match(summary, /^Approved owner\/repo #41\./);
  });
  const sql = recorded.map((r) => r.sql.replace(/\s+/g, " ").trim());
  assert.match(sql[0]!, /^UPDATE pr_approvals SET status = 'voided', .* WHERE id = \?1 AND status = 'approved' RETURNING id$/);
  assert.deepEqual(recorded[0]!.params, [7, NOW.toISOString(), "replaced"]);
  assert.ok(sql.some((s) => s.startsWith("INSERT INTO pr_approvals")), "no approval row was written");
  const insert = recorded.find((r) => r.sql.includes("INSERT INTO pr_approvals"))!;
  // The unit it counts toward (src/merge-units.ts): the namespace and the tick's path class.
  assert.deepEqual(insert.params, ["owner/repo", 41, HEAD_B, "approve", ACTOR, "portal", null, "reviewed the diff", NOW.toISOString(), "capsid", "src-routine"]);
});

test("Undo voids the open approval with 'undone', and is refused where there is none", async () => {
  const { env: none } = env([]);
  const refused = await planApproval(none, ACTOR, { namespace: "capsid", prs: "41", undo: "true" }, "portal", CLICK);
  assert.match(!refused.ok ? refused.refusal : "", /#41 has no open approval to undo/);
  const { env: e, recorded } = env([], [{ id: 7, pr: 41, head_sha: HEAD_A }]);
  const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41", undo: "true" }, "portal", CLICK);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  await performApproval(e, ACTOR, plan, null, NOW);
  assert.deepEqual(recorded[0]!.params, [7, NOW.toISOString(), "undone"]);
  assert.ok(!recorded.some((r) => r.sql.includes("INSERT INTO pr_approvals")), "an undo approved something");
});

test("a batch of two shares one batch id", async () => {
  const { env: e, recorded } = env([awaiting(41, "approve"), awaiting(42, "approve")]);
  await withFetch(pulls({ 41: HEAD_A, 42: HEAD_B }), async () => {
    const plan = await planApproval(e, ACTOR, { namespace: "capsid", prs: "41, 42", shas: `${HEAD_A} ${HEAD_B}` }, "chat", CLICK);
    assert.equal(plan.ok, true);
    if (plan.ok) await performApproval(e, ACTOR, plan, null, NOW);
  });
  const ids = recorded.filter((r) => r.sql.includes("INSERT INTO pr_approvals")).map((r) => r.params[6]);
  assert.equal(ids.length, 2);
  assert.equal(typeof ids[0], "string");
  assert.equal(ids[0], ids[1]);
});
