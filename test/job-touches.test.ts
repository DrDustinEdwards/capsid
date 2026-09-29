import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_KINDS, actorKind, touchStatement, type ActorKind } from "../src/job-touches.ts";
import { fakeD1 } from "./fakes.ts";

// The human-touch log's two pure pieces: who a touch is by (actorKind) and the INSERT
// that records it (touchStatement). Every transition that writes one is driven against
// a real D1 in test-integration/job-touches.test.ts, where waited_ms is SQLite's own
// julianday arithmetic rather than this file's fake.

test("actorKind: every caller the queue sees maps to one kind, and the table covers every kind", () => {
  const table: Array<[string, Parameters<typeof actorKind>[1], ActorKind]> = [
    // A person, whatever they are also allowed to do.
    ["access:admin@example.com", {}, "human"],
    ["access:admin@example.com", { seat: true }, "human"],
    ["github:sample-user", {}, "human"],
    // The seat: its minted credentials, a legacy operator key, and any caller whose
    // flags make it the seat.
    ["agent:seat", {}, "seat"],
    ["agent:site-seat", {}, "seat"],
    ["opkey:0123abcd", {}, "seat"],
    ["agent:sample-operator", { seat: true }, "seat"],
    // Drivers, including a seat-started runner and an unlisted minted agent.
    ["agent:sample-driver", {}, "driver"],
    ["agent:capsid-driver", {}, "driver"],
    ["agent:runner-job_aaaaaaaaaaaa-s1", {}, "driver"],
    ["agent:sample-session", {}, "driver"],
    // A driver's own resume under the signed gate policy is the policy's approval.
    ["agent:sample-driver", { policy: true }, "policy"],
    // The reviewer, by name or because the touch records a verdict.
    ["agent:reviewer", {}, "reviewer"],
    ["sample-app[bot]", { reviewer: true }, "reviewer"],
    // Scheduled credentials.
    ["agent:watcher", {}, "system"],
    ["agent:skills-refresh", {}, "system"],
    ["improve-loop", {}, "system"],
  ];
  for (const [actor, context, want] of table) {
    assert.equal(actorKind(actor, context), want, `${actor} ${JSON.stringify(context)}`);
  }
  const covered = new Set(table.map(([, , kind]) => kind));
  assert.deepEqual(
    ACTOR_KINDS.filter((k) => !covered.has(k)),
    [],
    "an actor_kind the table never produces is one no test has seen"
  );
});

test("PLANT: a person is human even when the same identity is the seat", () => {
  // The admin's Access login passes callerIsSeat. Were the seat check first, every
  // Portal approval would be logged as the seat's and the human-touch count would be 0.
  assert.equal(actorKind("access:admin@example.com", { seat: true }), "human");
});

test("PLANT: policy wins over the caller's own kind, so a driver's self-approval is not logged as a driver's plain resume", () => {
  assert.equal(actorKind("agent:sample-driver", { policy: true, seat: false }), "policy");
});

function capture() {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        seen.push({ sql, params });
        return { sql, params };
      },
    }),
  } as unknown as D1Database;
  return { db, seen };
}

test("touchStatement binds `at` and measures waited_ms in SQL from the latest gate by id", () => {
  const { db, seen } = capture();
  touchStatement(db, {
    job_id: "job_aaaaaaaaaaaa",
    namespace: "sample",
    kind: "approval",
    actor: "access:admin@example.com",
    actor_kind: "human",
    detail: { reason: "push approved", command: "git push", absent: undefined },
    sinceGate: true,
    at: "2026-09-29T10:00:00.250Z",
  });
  const [{ sql, params }] = seen;
  const flat = sql.replace(/\s+/g, " ");
  assert.match(flat, /INSERT INTO job_touches \(job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at\)/);
  // The same bound time on both sides of the difference, so the wait is one clock.
  assert.match(flat, /julianday\(\?7\) - julianday\(g\.at\)/);
  assert.match(flat, /\* 86400000\.0/);
  assert.match(flat, /g\.kind = 'gate' ORDER BY g\.id DESC LIMIT 1/);
  assert.deepEqual(params, [
    "job_aaaaaaaaaaaa",
    "sample",
    "approval",
    "access:admin@example.com",
    "human",
    JSON.stringify({ reason: "push approved", command: "git push" }),
    "2026-09-29T10:00:00.250Z",
    1,
  ]);
});

test("touchStatement: a touch that ends no wait binds 0, and no detail is NULL, not '{}'", () => {
  const { db, seen } = capture();
  touchStatement(db, {
    job_id: "job_aaaaaaaaaaaa",
    namespace: "sample",
    kind: "gate",
    actor: "agent:sample-driver",
    actor_kind: "driver",
    sinceGate: false,
    at: "2026-09-29T10:00:00.000Z",
  });
  assert.equal(seen[0].params[5], null);
  assert.equal(seen[0].params[7], 0);
});

test("PLANT: waited_ms is measured from the latest gate, not the first (fake D1)", async () => {
  // The fake resolves the subquery the way SQLite does, so the unit tests that drive
  // block and resume through it see the same waits the integration tests do.
  const d1 = fakeD1({});
  const at = (iso: string, kind: "gate" | "approval", sinceGate: boolean) =>
    touchStatement(d1.db, {
      job_id: "job_aaaaaaaaaaaa",
      namespace: "sample",
      kind,
      actor: "agent:seat",
      actor_kind: "seat",
      sinceGate,
      at: iso,
    });
  await d1.db.batch([
    at("2026-09-29T10:00:00.000Z", "gate", false),
    at("2026-09-29T11:00:00.000Z", "approval", true),
    at("2026-09-29T12:00:00.000Z", "gate", false),
    at("2026-09-29T12:00:01.500Z", "approval", true),
  ]);
  const waits = d1.rows.job_touches.map((t) => t.waited_ms);
  assert.deepEqual(waits, [null, 3_600_000, null, 1_500]);
});
