// Each test drives one statement shape src/ issues and asserts the row state SQLite would leave,
// so the fake cannot ignore a write or a predicate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./fakes.ts";

test("C1-17: a document upsert lands in the rows", async () => {
  const fake = fakeD1({
    documents: [{ namespace: "sample", path: "a.md", title: "old", body: "old body" }],
  });
  const upsert = (body: string) =>
    fake.db
      .prepare(
        `INSERT INTO documents (namespace, path, title, body)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, path) DO UPDATE SET title = ?3, body = excluded.body, updated_at = datetime('now')`,
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
      fake.db
        .prepare("UPDATE documents SET body = ?3 WHERE namespace = ?1 AND path = ?2")
        .bind("sample", "a.md", "after"),
      // requireMissing (src/store-guards.ts), which fires because the row exists.
      fake.db
        .prepare(
          `INSERT INTO document_versions (document_id, namespace, path)
           SELECT NULL, ?1, ?2
           WHERE EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`,
        )
        .bind("sample", "a.md"),
    ]),
    /NOT NULL constraint failed/,
  );
  assert.equal(fake.rows.documents[0].body, "before");
  assert.equal(fake.recorded.length, 0);
});

test("C1-18: the nightly jti prune keeps a nonce seen within the day", async () => {
  const fake = fakeD1();
  fake.rows.improve_jti.push({ scope: "backup", jti: "old", seen_at: "2020-01-01 00:00:00" });
  await fake.db
    .prepare(
      "INSERT INTO improve_jti (scope, jti) VALUES (?1, ?2) ON CONFLICT(scope, jti) DO NOTHING RETURNING jti",
    )
    .bind("backup", "fresh")
    .first();
  await fake.db.batch([
    fake.db.prepare("DELETE FROM improve_jti WHERE seen_at < datetime('now', '-1 day')"),
  ]);
  assert.deepEqual(
    fake.rows.improve_jti.map((r) => r.jti),
    ["fresh"],
  );
});
