import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_KINDS, actorKind, type ActorKind } from "../src/job-touches.ts";

test("actorKind: every caller the queue sees maps to one kind, and the table covers every kind", () => {
  const table: Array<[string, Parameters<typeof actorKind>[1], ActorKind]> = [
    // A person, even when the same identity is the seat (the admin's Access login passes
    // callerIsSeat): were the seat check first, every Portal approval would log as the seat's.
    ["access:admin@example.com", {}, "human"],
    ["access:admin@example.com", { seat: true }, "human"],
    ["github:sample-user", {}, "human"],
    ["agent:seat", {}, "seat"],
    ["agent:site-seat", {}, "seat"],
    ["agent:sample-operator", { seat: true }, "seat"],
    ["agent:sample-driver", {}, "driver"],
    ["agent:capsid-driver", {}, "driver"],
    ["agent:runner-job_aaaaaaaaaaaa-s1", {}, "driver"],
    ["agent:sample-session", {}, "driver"],
    // A driver's own resume under the signed gate policy is the policy's approval, not a plain resume.
    ["agent:sample-driver", { policy: true }, "policy"],
    ["agent:reviewer", {}, "reviewer"],
    ["sample-app[bot]", { reviewer: true }, "reviewer"],
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
