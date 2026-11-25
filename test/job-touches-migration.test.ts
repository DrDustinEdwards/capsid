import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TOUCH_KINDS } from "../src/job-touches.ts";

// job_touches.kind is a CHECK and SQLite cannot alter one, so adding a kind is a table rebuild; this runs
// the real migrations and keeps TOUCH_KINDS equal to the CHECK the schema ends with.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

function files(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function apply(db: DatabaseSync, names: string[]): void {
  for (const name of names) db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
}

test("TOUCH_KINDS is the CHECK's list, read from the schema every migration builds, both ways", () => {
  const db = new DatabaseSync(":memory:");
  apply(db, files());
  const sql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'job_touches'").get()!.sql,
  );
  const list = /kind TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(list, `no kind CHECK found in: ${sql.slice(0, 200)}`);
  const inSchema = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(
    inSchema.length >= 10,
    `read only ${inSchema.length} kinds from the CHECK, so this compared nothing`,
  );
  assert.deepEqual([...TOUCH_KINDS].sort(), [...inSchema].sort());
  db.close();
});
