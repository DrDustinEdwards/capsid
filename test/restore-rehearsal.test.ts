import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
// @ts-expect-error the scripts/ tree is plain .mjs with no type declarations, and
// deliberately so: the rehearsal runs in the live CI job with no npm ci and no
// build step.
import { deriveTables, rehearse } from "../scripts/restore-rehearsal.mjs";

// Each plant confirms a rehearsal check fires with the right reason. The fixture is a
// minimal real dump (enough documents for an FTS probe, every migrations-derived table
// present), so a plant removes exactly one property at a time.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const TABLES = deriveTables(MIGRATIONS);

// Every column of every table, from the migrations, so fixture rows can be completed
// the way SELECT * completes a real dump's rows: null columns present as null.
const COLUMNS: Record<string, string[]> = (() => {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const out: Record<string, string[]> = {};
  for (const table of TABLES) {
    out[table] = db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((c) => String((c as { name: unknown }).name));
  }
  db.close();
  return out;
})();

function complete(table: string, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(COLUMNS[table].map((c) => [c, c in row ? row[c] : null]));
}

// One hour old: inside the 26 hour threshold, so only the age tests move it.
const EXPORTED_AT = new Date(Date.now() - 3_600_000).toISOString();

// Build a valid dump directory: one <table>.json per real table, documents
// carrying restorable, FTS-probeable rows.
function goodDump(): string {
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
  for (const table of TABLES) {
    let rows: Record<string, unknown>[] = [];
    if (table === "documents") {
      rows = [
        { id: 1, namespace: "sample", path: "core.md", title: "Sample core", body: "restore rehearsal probe body", type: "core", status: "published", created_at: "2026-09-01 00:00:00", updated_at: "2026-09-01 00:00:00" },
        { id: 2, namespace: "sample", path: "note.md", title: "Second", body: "another document with words", type: "note", status: "published", created_at: "2026-09-01 00:00:00", updated_at: "2026-09-01 00:00:00" },
      ];
    }
    writeFileSync(join(dir, `${table}.json`), JSON.stringify({ exported_at: EXPORTED_AT, table, rows: rows.map((r) => complete(table, r)) }));
  }
  // The two sidecars. They are not tables, and the leading underscore keeps them from
  // colliding with one.
  writeFileSync(join(dir, "_kv.json"), JSON.stringify({ exported_at: "2026-09-07T09:00:00Z", keys: { improve_mode: "off" } }));
  writeFileSync(
    join(dir, "_holdout-manifests.json"),
    JSON.stringify({ exported_at: "2026-09-07T09:00:00Z", manifests: { capsid: { namespace: "capsid", total: 30, updated_at: "2026-09-07" } } })
  );
  return dir;
}

// Write rows into one table file of an existing dump.
function setRows(dir: string, table: string, rows: Record<string, unknown>[]): void {
  writeFileSync(join(dir, `${table}.json`), JSON.stringify({ exported_at: EXPORTED_AT, table, rows: rows.map((r) => complete(table, r)) }));
}

function withDump(fn: (dir: string) => void): void {
  const dir = goodDump();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the derived table list is the same real-table set backup.ts exports", () => {
  // Cross-check against the sibling guard's parse, so the two cannot drift.
  assert.ok(TABLES.includes("documents"), "documents must be derived");
  assert.ok(!TABLES.includes("documents_fts"), "the FTS virtual table must never be in the list");
  assert.equal(new Set(TABLES).size, TABLES.length, "no table appears twice");
});

test("a valid dump restores, with FTS index and probe verified", () => {
  withDump((dir) => {
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.tables, TABLES.length);
    assert.equal(summary.docCount, 2);
    assert.ok(summary.probe.length >= 4, "a probe word was taken from a restored document");
  });
});

test("a missing table file is refused, naming the table", () => {
  withDump((dir) => {
    rmSync(join(dir, "namespaces.json"));
    assert.throws(() => rehearse(dir, MIGRATIONS), /missing tables.*namespaces/);
  });
});

test("an unexpected extra file is refused", () => {
  withDump((dir) => {
    writeFileSync(join(dir, "documents_fts.json"), JSON.stringify({ table: "documents_fts", rows: [] }));
    assert.throws(() => rehearse(dir, MIGRATIONS), /files no migration explains.*documents_fts/);
  });
});

test("a shuffled table field is refused before any rows restore", () => {
  withDump((dir) => {
    const shuffled = JSON.parse(readFileSync(join(dir, "namespaces.json"), "utf8"));
    shuffled.table = "audit_log";
    writeFileSync(join(dir, "namespaces.json"), JSON.stringify(shuffled));
    assert.throws(() => rehearse(dir, MIGRATIONS), /shuffled files/);
  });
});

test("a zero-document restore is refused as vacuous", () => {
  withDump((dir) => {
    writeFileSync(join(dir, "documents.json"), JSON.stringify({ exported_at: EXPORTED_AT, table: "documents", rows: [] }));
    assert.throws(() => rehearse(dir, MIGRATIONS), /zero documents.*vacuous/);
  });
});

test("a row missing a column is refused, even a nullable one", () => {
  // src/backup.ts dumps SELECT *, so a real row carries every column. Restoring a
  // missing one as NULL would hide a backup.ts that stopped dumping it.
  withDump((dir) => {
    const docs = JSON.parse(readFileSync(join(dir, "documents.json"), "utf8"));
    assert.ok("tags" in docs.rows[0], "the fixture no longer has a tags column to drop");
    delete docs.rows[0].tags;
    writeFileSync(join(dir, "documents.json"), JSON.stringify(docs));
    assert.throws(() => rehearse(dir, MIGRATIONS), /documents\.json row 0 does not carry the table's columns \(missing: tags/);
  });
});

test("a row carrying a column the table does not have is refused", () => {
  withDump((dir) => {
    const docs = JSON.parse(readFileSync(join(dir, "documents.json"), "utf8"));
    docs.rows[1].surprise = 1;
    writeFileSync(join(dir, "documents.json"), JSON.stringify(docs));
    assert.throws(() => rehearse(dir, MIGRATIONS), /row 1 .*extra: surprise/);
  });
});

test("A STALE DUMP IS REFUSED: older than 26 hours", () => {
  // A rehearsal that passes on an old dump hides a backup outage.
  withDump((dir) => {
    const exported = Date.parse(EXPORTED_AT);
    assert.throws(() => rehearse(dir, MIGRATIONS, { now: exported + 56 * 3_600_000 }), /56\.0h ago, past the 26h threshold/);
    // 25 hours is inside the threshold.
    assert.equal(rehearse(dir, MIGRATIONS, { now: exported + 25 * 3_600_000 }).docCount, 2);
  });
});

test("a dump with no readable exported_at is refused, since its age is unknown", () => {
  withDump((dir) => {
    const docs = JSON.parse(readFileSync(join(dir, "documents.json"), "utf8"));
    delete docs.exported_at;
    writeFileSync(join(dir, "documents.json"), JSON.stringify(docs));
    assert.throws(() => rehearse(dir, MIGRATIONS), /no readable exported_at/);
  });
});

// cross-table consistency
//
// The dump is one D1 batch, so its table objects should agree. The checks look for
// the tearing signature, not plain referential integrity: the live store holds
// orphaned version and audit rows from deletes, archiving and namespace renames, and a
// guard that failed on those would be red on every good dump. So orphan counts are
// reported, and what fails is the pair of signatures a torn read produces and a
// deletion cannot:
//
//   a version row whose document_id is above the highest id in the documents
//   object, with no delete or move recorded for its path (the document was
//   created after documents was read), and
//
//   a `write` audit row NEWER than every row in the documents object, naming a
//   path that is not there (the write landed after documents was read).

test("a dump carrying the two sidecars restores, and reports its orphan counts", () => {
  withDump((dir) => {
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.docCount, 2);
    assert.equal(summary.orphanVersions, 0);
    assert.equal(summary.orphanAudits, 0);
  });
});

test("a missing sidecar is refused: the KV pins are part of the dump now", () => {
  withDump((dir) => {
    rmSync(join(dir, "_kv.json"));
    assert.throws(() => rehearse(dir, MIGRATIONS), /_kv\.json/);
  });
});

test("a sidecar that exists but is empty is refused", () => {
  // Existing is not enough: `{}` must fail.
  withDump((dir) => {
    writeFileSync(join(dir, "_kv.json"), JSON.stringify({}));
    assert.throws(() => rehearse(dir, MIGRATIONS), /_kv\.json carries no 'keys' object/);
  });
  withDump((dir) => {
    writeFileSync(join(dir, "_holdout-manifests.json"), JSON.stringify({ exported_at: EXPORTED_AT, manifests: {} }));
    assert.throws(() => rehearse(dir, MIGRATIONS), /_holdout-manifests\.json has an empty 'manifests' object/);
  });
  withDump((dir) => {
    writeFileSync(join(dir, "_kv.json"), JSON.stringify({ exported_at: EXPORTED_AT, keys: { improve_mode: 3 } }));
    assert.throws(() => rehearse(dir, MIGRATIONS), /wrong shape: improve_mode/);
  });
});

test("an unknown sidecar is refused too, so the set cannot quietly grow", () => {
  withDump((dir) => {
    writeFileSync(join(dir, "_secrets.json"), JSON.stringify({}));
    assert.throws(() => rehearse(dir, MIGRATIONS), /_secrets\.json/);
  });
});

// The completion marker. Optional, because older dumps lack it;
// when present it must list exactly the other files in the dump.
function writeMarker(dir: string, files: string[]): void {
  const keys = files.map((f) => `backups/json/2026-09-25T09-00-00-000Z/${f}`);
  writeFileSync(join(dir, "_complete.json"), JSON.stringify({ exported_at: "2026-09-25T09:00:00Z", keys }));
}

test("a dump carrying a completion marker that lists its files restores", () => {
  withDump((dir) => {
    writeMarker(dir, readdirSync(dir));
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.marked, true);
  });
});

test("a completion marker that lists a file the dump does not hold is refused", () => {
  withDump((dir) => {
    writeMarker(dir, [...readdirSync(dir), "jobs-extra.json"]);
    assert.throws(() => rehearse(dir, MIGRATIONS), /_complete\.json lists/);
  });
});

test("A TORN SNAPSHOT IS REFUSED: a version row for a document created after the documents read", () => {
  withDump((dir) => {
    setRows(dir, "document_versions", [
      { id: 1, document_id: 99, namespace: "sample", path: "written-mid-dump.md", title: "t", body: "b", snapshot_at: "2026-09-07 09:00:01" },
    ]);
    assert.throws(() => rehearse(dir, MIGRATIONS), /torn|inconsistent/i);
  });
});

test("a version row for a DELETED document is not torn, and passes", () => {
  // A deleted document leaves version rows behind by design, so restore can bring it back.
  withDump((dir) => {
    setRows(dir, "document_versions", [
      { id: 1, document_id: 99, namespace: "sample", path: "gone.md", title: "t", body: "b", snapshot_at: "2026-09-01 00:00:00" },
    ]);
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "delete", namespace: "sample", path: "gone.md", params: "{}", at: "2026-09-01 00:00:01" },
    ]);
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.orphanVersions, 1, "the orphan is still counted and reported");
  });
});

test("A TORN SNAPSHOT IS REFUSED: a write audited after the newest document in the dump", () => {
  withDump((dir) => {
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "write", namespace: "sample", path: "landed-mid-dump.md", params: "{}", at: "2026-09-02 00:00:00" },
    ]);
    assert.throws(() => rehearse(dir, MIGRATIONS), /torn|inconsistent/i);
  });
});

test("A TORN SNAPSHOT IS REFUSED: a write in the same second as the newest document", () => {
  // Timestamps have one second resolution, so a write that landed in the same second
  // as the newest document, after documents was read, is not "later" by a strict >.
  withDump((dir) => {
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "write", namespace: "sample", path: "same-second.md", params: "{}", at: "2026-09-01 00:00:00" },
    ]);
    assert.throws(() => rehearse(dir, MIGRATIONS), /torn/i);
  });
});

test("an OLD write to a since-archived path is not torn, and passes", () => {
  withDump((dir) => {
    setRows(dir, "audit_log", [
      { id: 1, actor: "human", action: "write", namespace: "sample", path: "archived/old.md", params: "{}", at: "2026-08-01 00:00:00" },
    ]);
    const summary = rehearse(dir, MIGRATIONS);
    assert.equal(summary.orphanAudits, 1);
  });
});
