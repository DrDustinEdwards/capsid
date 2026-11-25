import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_KINDS, actorKind, type ActorKind } from "../src/job-touches.ts";

// Who a human-touch row is by (actorKind). Every transition that writes one, and the INSERT
// itself with waited_ms from the latest gate, is driven against a real D1 in
// test-integration/job-touches.test.ts.

test("actorKind: every caller the queue sees maps to one kind, and the table covers every kind", () => {
  const table: Array<[string, Parameters<typeof actorKind>[1], ActorKind]> = [
    // A person, even when the same identity is the seat (the admin's Access login passes
    // callerIsSeat): were the seat check first, every Portal approval would log as the seat's.
    ["access:admin@example.com", {}, "human"],
    ["access:admin@example.com", { seat: true }, "human"],
    ["github:sample-user", {}, "human"],
    // The seat: its minted credentials and any caller whose flags make it the seat.
    ["agent:seat", {}, "seat"],
    ["agent:site-seat", {}, "seat"],
    ["agent:sample-operator", { seat: true }, "seat"],
    // Drivers, including a seat-started runner and an unlisted minted agent.
    ["agent:sample-driver", {}, "driver"],
    ["agent:capsid-driver", {}, "driver"],
    ["agent:runner-job_aaaaaaaaaaaa-s1", {}, "driver"],
    ["agent:sample-session", {}, "driver"],
    // A driver's own resume under the signed gate policy is the policy's approval, not a plain resume.
    ["agent:sample-driver", { policy: true }, "policy"],
    // The reviewer, by name or because the touch records a verdict.
    ["agent:reviewer", {}, "reviewer"],
    ["sample-app[bot]", { reviewer: true }, "reviewer"],
    // Scheduled credentials.
    ["agent:watcher", {}, "system"],
    ["improve-loop", {}, "system"],
  ];
  for (const [actor, context, want] of table) {
    assert.equal(actorKind(actor, context), want, `${actor} ${JSON.stringify(context)}`);
  }
  const covered = new Set(table.map(([, , kind]) => kind));
  assert.deepEqual(
    ACTOR_KINDS.filter((k) => !covered.has(k)),
    [],
    "an actor_kind the table never produces is one no test has seen",
  );
});
