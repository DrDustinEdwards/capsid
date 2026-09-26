import assert from "node:assert/strict";
import { test } from "node:test";
import { activityFilterFrom, loadActivity } from "../src/console-activity.ts";
import { fakeD1 } from "./fakes.ts";

// Recent activity: the last 50 audit rows, filterable by namespace and actor. The
// filter comes from a browser's query string, so it is untrusted input reaching SQL,
// and the defence is that both values are bound rather than interpolated. The tests
// check the statement's shape, because a bound parameter that becomes a template
// literal passes every results-only test.

test("no filter asks for the whole log, bounded", () => {
  const filter = activityFilterFrom(new URL("https://capsid.example/console"));
  assert.equal(filter.namespace, null);
  assert.equal(filter.actor, null);
});

test("the filter reads namespace and actor off the query string, trimmed", () => {
  const filter = activityFilterFrom(new URL("https://capsid.example/console?namespace=capsid&actor=%20agent%3Acapsid-driver%20"));
  assert.equal(filter.namespace, "capsid");
  assert.equal(filter.actor, "agent:capsid-driver");
});

test("an empty or whitespace filter value is no filter, not a filter on the empty string", () => {
  const filter = activityFilterFrom(new URL("https://capsid.example/console?namespace=&actor=%20%20"));
  assert.equal(filter.namespace, null);
  assert.equal(filter.actor, null);
});

test("the filter values are BOUND, never interpolated into the statement", async () => {
  const d1 = fakeD1();
  await loadActivity(d1.db, { namespace: "capsid'; DROP TABLE documents; --", actor: "agent:x" });
  const read = d1.reads.find((r) => /FROM audit_log/i.test(r.sql));
  assert.ok(read, "the activity query never reached the database");
  assert.doesNotMatch(read.sql, /DROP TABLE/, "a filter value was interpolated into the SQL");
  assert.ok(
    read.params.includes("capsid'; DROP TABLE documents; --"),
    `the namespace filter was not bound: ${JSON.stringify(read.params)}`
  );
  assert.ok(read.params.includes("agent:x"));
});

// The LIMIT, the newest-first order and the two filter clauses are proven by the rows
// they return from a real audit_log: test-integration/console-activity.test.ts.
