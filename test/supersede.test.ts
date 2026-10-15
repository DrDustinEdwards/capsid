import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SUPERSEDE_ACTOR, SUPERSEDE_MAX, supersedePass } from "../src/supersede.ts";
import { fakeEnv } from "./fakes.ts";

// The pass runs against the real migrations in Node's SQLite, so the snapshot, the
// status change and the audit row are what D1 would hold.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const s = db.prepare(sql);
    const args = params as Array<string | number | null>;
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (s.get(...args) as Record<string, unknown> | undefined) ?? null,
      all: async () => ({ results: s.all(...args).map((r) => ({ ...r })) }),
      run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }),
      exec: () => (/\bRETURNING\b|^\s*SELECT/i.test(sql) ? { results: s.all(...args) } : (s.run(...args), { results: [] })),
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: Array<{ exec: () => unknown }>) => {
      db.exec("BEGIN");
      try {
        const out = list.map((st) => st.exec());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

function fresh(): { raw: DatabaseSync; env: never } {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return { raw, env: fakeEnv({ DB: d1(raw) }) };
}

function put(raw: DatabaseSync, path: string, status = "published"): void {
  raw.prepare("INSERT INTO documents (namespace, path, title, body, status) VALUES ('sample', ?, ?, 'body of ' || ?, ?)").run(path, path, path, status);
}

function link(raw: DatabaseSync, from: string, type: string, to: string): void {
  raw.prepare("INSERT INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES ('sample', ?, ?, 'sample', ?)").run(from, type, to);
}

const status = (raw: DatabaseSync, path: string) => (raw.prepare("SELECT status FROM documents WHERE path = ?").get(path) as { status: string }).status;

test("a live document's supersedes or replaces edge marks its target superseded, with a snapshot and an audit row", async () => {
  const { raw, env } = fresh();
  for (const p of ["new.md", "old.md", "older.md", "cited.md"]) put(raw, p);
  link(raw, "new.md", "supersedes", "old.md");
  link(raw, "new.md", "replaces", "older.md");
  link(raw, "new.md", "references", "cited.md");

  const report = await supersedePass(env);
  assert.deepEqual(report.marked.map((m) => m.document).sort(), ["sample/old.md", "sample/older.md"]);
  assert.equal(status(raw, "old.md"), "superseded");
  assert.equal(status(raw, "older.md"), "superseded");
  assert.equal(status(raw, "cited.md"), "published", "a references edge changes nothing");
  assert.equal(status(raw, "new.md"), "published");

  const versions = raw.prepare("SELECT path, body FROM document_versions ORDER BY path").all() as Array<{ path: string; body: string }>;
  assert.deepEqual(versions.map((v) => v.path), ["old.md", "older.md"], "each change snapshots the live row first");
  const audit = raw.prepare("SELECT actor, action, path, params FROM audit_log ORDER BY path").all() as Array<{ actor: string; action: string; path: string; params: string }>;
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actor, SUPERSEDE_ACTOR);
  assert.deepEqual(JSON.parse(audit[0].params), { status: "superseded", prior_status: "published", superseded_by: "sample/new.md", link: "supersedes" });

  assert.deepEqual((await supersedePass(env)).marked, [], "a second pass finds nothing left to do");
});

test("an edge from a draft, closed or superseded document changes nothing, and a closed target is left closed", async () => {
  const { raw, env } = fresh();
  put(raw, "draft.md", "draft");
  put(raw, "gone.md", "superseded");
  put(raw, "live.md");
  put(raw, "a.md");
  put(raw, "b.md");
  put(raw, "done.md", "closed");
  link(raw, "draft.md", "supersedes", "a.md");
  link(raw, "gone.md", "supersedes", "b.md");
  link(raw, "live.md", "supersedes", "done.md");
  assert.deepEqual((await supersedePass(env)).marked, []);
  assert.equal(status(raw, "a.md"), "published");
  assert.equal(status(raw, "b.md"), "published");
  assert.equal(status(raw, "done.md"), "closed");
});

test("one pass changes at most a bounded number and says there are more", async () => {
  const { raw, env } = fresh();
  put(raw, "new.md");
  for (let i = 0; i <= SUPERSEDE_MAX; i++) {
    put(raw, `old-${String(i).padStart(3, "0")}.md`);
    link(raw, "new.md", "supersedes", `old-${String(i).padStart(3, "0")}.md`);
  }
  const first = await supersedePass(env);
  assert.equal(first.marked.length, SUPERSEDE_MAX);
  assert.equal(first.more, true);
  const second = await supersedePass(env);
  assert.equal(second.marked.length, 1);
  assert.equal(second.more, false);
});
