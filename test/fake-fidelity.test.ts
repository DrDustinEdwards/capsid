// The D1 fake disagrees with a handler where SQLite would. Each test drives one
// statement shape that src/ issues, in the words src/ issues it, and asserts the row
// state SQLite would leave, so the fake cannot ignore a write, ignore a predicate, or
// parse the statement wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./fakes.ts";

test("C1-17: a document upsert lands in the rows", async () => {
  const fake = fakeD1({ documents: [{ namespace: "sample", path: "a.md", title: "old", body: "old body" }] });
  const upsert = (body: string) =>
    fake.db
      .prepare(
        `INSERT INTO documents (namespace, path, title, body)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, path) DO UPDATE SET title = ?3, body = excluded.body, updated_at = datetime('now')`
      )
      .bind("sample", "a.md", "new", body);
  await fake.db.batch([upsert("lorem ipsum")]);
  assert.equal(fake.rows.documents.length, 1);
  assert.equal(fake.rows.documents[0].body, "lorem ipsum");
  assert.equal(fake.rows.documents[0].title, "new");
});

test("C1-17: a batch that aborts on a guard leaves every row as it was", async () => {
  const fake = fakeD1({ documents: [{ namespace: "sample", path: "a.md", body: "before" }] });
  await assert.rejects(
    fake.db.batch([
      fake.db.prepare("UPDATE documents SET body = ?3 WHERE namespace = ?1 AND path = ?2").bind("sample", "a.md", "after"),
      // requireMissing (src/store-guards.ts), which fires because the row exists.
      fake.db
        .prepare(
          `INSERT INTO document_versions (document_id, namespace, path)
           SELECT NULL, ?1, ?2
           WHERE EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`
        )
        .bind("sample", "a.md"),
    ]),
    /NOT NULL constraint failed/
  );
  assert.equal(fake.rows.documents[0].body, "before");
  assert.equal(fake.recorded.length, 0);
});

test("C1-17: run() reports the rows a write moved, and 0 when its WHERE matched nothing", async () => {
  const fake = fakeD1({ agents: [{ id: "ag-1", name: "one", revoked_at: null }] });
  const touch = (id: string) => fake.db.prepare("UPDATE agents SET last_seen = datetime('now') WHERE id = ?1").bind(id).run();
  assert.equal((await touch("ag-1")).meta.changes, 1);
  assert.equal((await touch("nobody")).meta.changes, 0);
  assert.equal(typeof fake.rows.agents[0].last_seen, "string");
});

test("C1-17: a keyed jobs UPDATE ... RETURNING moves only the row its CAS names", async () => {
  const fake = fakeD1({
    jobs: [{ id: "j-1", namespace: "sample", title: "t", status: "queued", posted_by: "watcher" }],
  });
  // The watcher's clear (src/watcher.ts): only a queued job it posted.
  const clear = (postedBy: string) =>
    fake.db
      .prepare(
        `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
         WHERE id = ?1 AND status = 'queued' AND posted_by = ?4 RETURNING id`
      )
      .bind("j-1", "cleared", "2026-09-25T00:00:00.000Z", postedBy)
      .first<{ id: string }>();
  assert.equal(await clear("someone-else"), null);
  assert.equal(fake.rows.jobs[0].status, "queued");
  assert.deepEqual(await clear("watcher"), { id: "j-1" });
  assert.equal(fake.rows.jobs[0].status, "failed");
});

test("C1-17: a COUNT over jobs counts, and a jobs read applies every filter", async () => {
  const fake = fakeD1({
    jobs: [
      { id: "j-1", namespace: "sample", title: "a", status: "done", posted_by: "p", updated_at: "2026-09-25T01:00:00.000Z" },
      { id: "j-2", namespace: "sample", title: "b", status: "done", posted_by: "p", updated_at: "2026-09-24T01:00:00.000Z" },
      { id: "j-3", namespace: "sample", title: "c", status: "claimed", claimed_by: "agent:b", posted_by: "p" },
    ],
  });
  const done = await fake.db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE namespace = ?1 AND status = 'done' AND substr(updated_at, 1, 10) = ?2")
    .bind("sample", "2026-09-25")
    .first<{ n: number }>();
  assert.deepEqual(done, { n: 1 });
  const held = await fake.db
    .prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1")
    .bind("agent:a")
    .first();
  assert.equal(held, null);
});

test("C1-18: the nightly jti prune keeps a nonce seen within the day", async () => {
  const fake = fakeD1();
  fake.rows.improve_jti.push({ scope: "backup", jti: "old", seen_at: "2020-01-01 00:00:00" });
  await fake.db.prepare("INSERT INTO improve_jti (scope, jti) VALUES (?1, ?2) ON CONFLICT(scope, jti) DO NOTHING RETURNING jti").bind("backup", "fresh").first();
  await fake.db.batch([fake.db.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')")]);
  assert.deepEqual(
    fake.rows.improve_jti.map((r) => r.jti),
    ["fresh"]
  );
});

