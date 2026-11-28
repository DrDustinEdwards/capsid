import assert from "node:assert/strict";
import { test } from "node:test";
import { activityFilterFrom, loadActivity } from "../src/portal-activity.ts";
import { d1, migratedDb } from "./sqlite-d1.ts";

test("the filter reads id, namespace and actor off the query string; a bad id is refused, an empty value is no filter", () => {
  const filter = (query: string) => {
    const parsed = activityFilterFrom(new URL(`https://capsid.example/portal?${query}`));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.refusal);
    return parsed.filter;
  };
  assert.equal(filter("id=1234").id, 1234);
  for (const bad of ["0", "-3", "1.5", "12abc", "1e3", "x", "01"]) {
    const parsed = activityFilterFrom(new URL(`https://capsid.example/portal?id=${bad}`));
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.ok ? "" : parsed.refusal, /id must be an audit row id/);
  }
  const both = filter("namespace=capsid&actor=%20agent%3Acapsid-driver%20");
  assert.equal(both.namespace, "capsid");
  assert.equal(both.actor, "agent:capsid-driver");
  const empty = filter("namespace=&actor=%20%20");
  assert.equal(empty.namespace, null);
  assert.equal(empty.actor, null);
});

test("an id reads that one row, whatever the namespace and actor filters say", async () => {
  const raw = migratedDb();
  raw.exec(
    `INSERT INTO audit_log (id, actor, action, namespace, path, params) VALUES
       (41, 'agent:x', 'write', 'capsid', 'a.md', '{}'),
       (42, 'agent:y', 'write', 'sample', 'b.md', '{}')`,
  );
  const db = d1(raw);
  const rows = await loadActivity(db, { namespace: "capsid", actor: "agent:x", id: 42 });
  assert.deepEqual(
    rows.map((r) => r.id),
    [42],
  );
  const filtered = await loadActivity(db, { namespace: "capsid", actor: "agent:x", id: null });
  assert.deepEqual(
    filtered.map((r) => r.id),
    [41],
  );
});
