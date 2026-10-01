import assert from "node:assert/strict";
import { test } from "node:test";
import { activityFilterFrom, loadActivity } from "../src/portal-activity.ts";
import { fakeD1 } from "./fakes.ts";

// Recent activity: the last 50 audit rows, filterable by namespace and actor. The
// filter comes from a browser's query string, so it is untrusted input reaching SQL,
// and the defence is that both values are bound rather than interpolated. The tests
// check the statement's shape, because a bound parameter that becomes a template
// literal passes every results-only test.

function filterOf(url: string) {
  const parsed = activityFilterFrom(new URL(url));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.refusal);
  return parsed.filter;
}

test("no filter asks for the whole log, bounded", () => {
  const filter = filterOf("https://capsid.example/console");
  assert.equal(filter.namespace, null);
  assert.equal(filter.actor, null);
  assert.equal(filter.id, null);
});

test("an id reads as a number; anything that is not a row id is refused, not dropped", () => {
  assert.equal(filterOf("https://capsid.example/console?id=1234").id, 1234);
  for (const bad of ["0", "-3", "1.5", "12abc", "1e3", "x", "01"]) {
    const parsed = activityFilterFrom(new URL(`https://capsid.example/console?id=${bad}`));
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.ok ? "" : parsed.refusal, /id must be an audit row id/);
  }
});

test("PLANT: the id is BOUND, and the namespace and actor filters are not applied beside it", async () => {
  const d1 = fakeD1();
  await loadActivity(d1.db, { namespace: "capsid", actor: "agent:x", id: 42 });
  const read = d1.reads.find((r) => /FROM audit_log/i.test(r.sql));
  assert.ok(read, "the activity query never reached the database");
  assert.match(read.sql, /WHERE id = \?1 ORDER BY id DESC LIMIT \?2/);
  assert.deepEqual(read.params, [42, 50]);
});

test("the filter reads namespace and actor off the query string, trimmed", () => {
  const filter = filterOf("https://capsid.example/console?namespace=capsid&actor=%20agent%3Acapsid-driver%20");
  assert.equal(filter.namespace, "capsid");
  assert.equal(filter.actor, "agent:capsid-driver");
});

test("an empty or whitespace filter value is no filter, not a filter on the empty string", () => {
  const filter = filterOf("https://capsid.example/console?namespace=&actor=%20%20");
  assert.equal(filter.namespace, null);
  assert.equal(filter.actor, null);
});

test("the filter values are BOUND, never interpolated into the statement", async () => {
  const d1 = fakeD1();
  await loadActivity(d1.db, { namespace: "capsid'; DROP TABLE documents; --", actor: "agent:x", id: null });
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
// they return from a real audit_log: test-integration/portal-activity.test.ts.
