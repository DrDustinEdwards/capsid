import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TOUCH_KINDS } from "../src/job-touches.ts";

// job_touches.kind is a CHECK, and SQLite cannot alter a CHECK, so adding the kind
// admin_complete is a table rebuild (migrations/0031_job_touches_admin_complete.sql).
// These tests run the real migrations in order with Node's SQLite, plant rows before
// the rebuild and read them after it, since a rebuild that lost a row, an id, the index
// or an append-only trigger would pass every test that starts from an empty table.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const REBUILD = "0031_job_touches_admin_complete.sql";

function files(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

function apply(db: DatabaseSync, names: string[]): void {
  for (const name of names) db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
}

// Every migration before the rebuild, so the table has the old CHECK.
function before(): DatabaseSync {
  const all = files();
  const at = all.indexOf(REBUILD);
  assert.ok(at > 0, `${REBUILD} is not in migrations/, so there is nothing to test`);
  const db = new DatabaseSync(":memory:");
  apply(db, all.slice(0, at));
  return db;
}

const PLANTED = [
  { id: 1, job_id: "job_aaaaaaaaaaaa", namespace: "capsid", kind: "gate", actor: "agent:capsid-driver", actor_kind: "driver", waited_ms: null, detail: '{"command":"git push"}', at: "2026-10-01T10:00:00.000Z" },
  { id: 2, job_id: "job_aaaaaaaaaaaa", namespace: "capsid", kind: "approval", actor: "access:dustin@example.com", actor_kind: "human", waited_ms: 3600000, detail: null, at: "2026-10-01T11:00:00.000Z" },
  { id: 7, job_id: "job_bbbbbbbbbbbb", namespace: "capsid", kind: "admin_fail", actor: "agent:seat", actor_kind: "seat", waited_ms: 5, detail: '{"reason":"gone"}', at: "2026-10-02T09:00:00.000Z" },
];

function plant(db: DatabaseSync): void {
  const insert = db.prepare("INSERT INTO job_touches (id, job_id, namespace, kind, actor, actor_kind, waited_ms, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of PLANTED) insert.run(r.id, r.job_id, r.namespace, r.kind, r.actor, r.actor_kind, r.waited_ms, r.detail, r.at);
}

const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM job_touches ORDER BY id").all().map((r) => ({ ...r }));

test("PLANT: the rebuild keeps every row with its id and every column, and the sequence carries on past the highest id", () => {
  const db = before();
  plant(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_touches").get()!.n, PLANTED.length, "the plant did not land");
  apply(db, [REBUILD]);
  assert.deepEqual(rows(db), PLANTED);
  // id 7 was the highest, so the next row is 8, not 3 and not 1.
  db.prepare("INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, at) VALUES ('job_cccccccccccc', 'capsid', 'admin_complete', 'agent:seat', 'seat', '2026-10-06T00:00:00.000Z')").run();
  assert.equal(db.prepare("SELECT MAX(id) AS id FROM job_touches").get()!.id, 8);
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'job_touches'").get();
  assert.equal(sequence?.seq, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'job_touches_new'").get()!.n, 0, "the scratch table's sequence row was left behind");
  db.close();
});

test("the rebuild keeps the index and both append-only triggers, and they still abort an UPDATE and a DELETE", () => {
  const db = before();
  plant(db);
  apply(db, [REBUILD]);
  const names = (type: string) =>
    db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'job_touches' AND type = ? ORDER BY name").all(type).map((r) => String(r.name));
  assert.ok(names("index").includes("job_touches_job"));
  assert.deepEqual(names("trigger"), ["job_touches_append_only_delete", "job_touches_append_only_update"]);
  assert.throws(() => db.prepare("UPDATE job_touches SET actor = 'x' WHERE id = 1").run(), /job_touches is append-only/);
  assert.throws(() => db.prepare("DELETE FROM job_touches WHERE id = 1").run(), /job_touches is append-only/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'job_touches_new'").get(), undefined, "the scratch table is still there");
  db.close();
});

test("admin_complete is refused before the rebuild and accepted after it, and a made-up kind is refused both times", () => {
  const db = before();
  const insert = (kind: string) =>
    db.prepare("INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, at) VALUES ('job_dddddddddddd', 'capsid', ?, 'agent:seat', 'seat', '2026-10-06T00:00:00.000Z')").run(kind);
  assert.throws(() => insert("admin_complete"), /CHECK constraint failed/);
  apply(db, [REBUILD]);
  insert("admin_complete");
  assert.throws(() => insert("made_up"), /CHECK constraint failed/);
  // The other CHECK came across too.
  assert.throws(
    () => db.prepare("INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, at) VALUES ('job_dddddddddddd', 'capsid', 'gate', 'x', 'robot', '2026-10-06')").run(),
    /CHECK constraint failed/
  );
  db.close();
});

test("TOUCH_KINDS is the CHECK's list, read from the schema every migration builds, both ways", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, files());
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'job_touches'").get()!.sql);
  const list = /kind TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(list, `no kind CHECK found in: ${sql.slice(0, 200)}`);
  const inSchema = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(inSchema.length >= 10, `read only ${inSchema.length} kinds from the CHECK, so this compared nothing`);
  assert.deepEqual([...TOUCH_KINDS].sort(), [...inSchema].sort());
  db.close();
});
