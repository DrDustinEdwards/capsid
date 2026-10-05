import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDump } from "../scripts/dump-invariants.mjs";

// The checks the d1-dump restore drill cannot make (scripts/dump-invariants.mjs). Each
// plant removes exactly one property of a good dump and names the reason that fires.

const DOC = { namespace: "sample", title: "t", body: "b", type: "note", status: "published", created_at: "2026-09-01 00:00:00" };
const ROWS: Record<string, Record<string, unknown>[]> = {
  documents: [
    { ...DOC, id: 1, path: "core.md", updated_at: "2026-09-01 00:00:00" },
    { ...DOC, id: 2, path: "note.md", updated_at: "2026-09-01 00:00:05" },
  ],
  document_versions: [],
  audit_log: [],
};

function write(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value));
}

function table(dir: string, name: string, rows: Record<string, unknown>[]): void {
  write(dir, `${name}.json`, { exported_at: "2026-09-07T09:00:00Z", table: name, rows });
}

// A complete run: three tables, both sidecars and a marker that lists every file.
function goodDump(): string {
  const dir = mkdtempSync(join(tmpdir(), "dump-invariants-"));
  for (const [name, rows] of Object.entries(ROWS)) table(dir, name, rows);
  write(dir, "_kv.json", { exported_at: "2026-09-07T09:00:00Z", keys: { improve_mode: "off" } });
  write(dir, "_holdout-manifests.json", { exported_at: "2026-09-07T09:00:00Z", manifests: { capsid: { total: 30 } } });
  seal(dir);
  return dir;
}

// Rewrites the marker to list exactly what the directory now holds.
function seal(dir: string): void {
  const keys = readdirSync(dir).filter((f) => f !== "_complete.json").map((f) => `backups/json/run/${f}`);
  write(dir, "_complete.json", { exported_at: "2026-09-07T09:00:00Z", keys });
}

function withDump(fn: (dir: string) => void): void {
  const dir = goodDump();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a good dump passes, and the summary says what was read", () => {
  withDump((dir) => {
    assert.deepEqual(checkDump(dir), { files: 6, tables: 3, rows: 2, documents: 2, orphanVersions: 0, orphanAudits: 0 });
  });
});

test("PLANT: a gutted dump with no documents is refused as vacuous", () => {
  withDump((dir) => {
    table(dir, "documents", []);
    assert.throws(() => checkDump(dir), /zero documents/);
  });
});

test("a directory with no marker, or no files at all, is refused", () => {
  withDump((dir) => {
    rmSync(join(dir, "_complete.json"));
    assert.throws(() => checkDump(dir), /not a complete dump/);
  });
  const empty = mkdtempSync(join(tmpdir(), "dump-invariants-empty-"));
  try {
    assert.throws(() => checkDump(empty), /read nothing/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a marker that lists a file the dump does not hold is refused", () => {
  withDump((dir) => {
    write(dir, "_complete.json", { keys: ["backups/json/run/documents.json", "backups/json/run/ghost.json"] });
    assert.throws(() => checkDump(dir), /lists .*ghost\.json but the dump holds/);
  });
});

test("a missing, empty or unknown sidecar is refused", () => {
  withDump((dir) => {
    rmSync(join(dir, "_kv.json"));
    seal(dir);
    assert.throws(() => checkDump(dir), /missing sidecars: _kv\.json/);
  });
  withDump((dir) => {
    write(dir, "_kv.json", { exported_at: "2026-09-07T09:00:00Z", keys: {} });
    assert.throws(() => checkDump(dir), /empty 'keys' object/);
  });
  withDump((dir) => {
    write(dir, "_extra.json", {});
    seal(dir);
    assert.throws(() => checkDump(dir), /sidecars nothing verifies: _extra\.json/);
  });
});

test("a shuffled table file, and a row that lost a column, are refused", () => {
  withDump((dir) => {
    write(dir, "audit_log.json", { exported_at: "x", table: "document_versions", rows: [] });
    assert.throws(() => checkDump(dir), /audit_log\.json says it dumps 'document_versions'/);
  });
  withDump((dir) => {
    const [first, second] = ROWS.documents;
    const { updated_at: _dropped, ...short } = second;
    table(dir, "documents", [first, short]);
    assert.throws(() => checkDump(dir), /documents\.json row 1 does not carry the columns of row 0/);
  });
});

test("A TORN SNAPSHOT IS REFUSED: a version row for a document created after the documents read", () => {
  withDump((dir) => {
    table(dir, "document_versions", [{ id: 1, document_id: 99, namespace: "sample", path: "mid-dump.md" }]);
    assert.throws(() => checkDump(dir), /TORN.*document_versions 1 snapshots document 99/);
  });
});

test("a version row for a DELETED document is not torn, and is counted as an orphan", () => {
  withDump((dir) => {
    table(dir, "document_versions", [{ id: 1, document_id: 99, namespace: "sample", path: "gone.md" }]);
    table(dir, "audit_log", [{ id: 1, action: "delete", namespace: "sample", path: "gone.md", at: "2026-09-01 00:00:01" }]);
    assert.equal(checkDump(dir).orphanVersions, 1);
  });
});

test("A TORN SNAPSHOT IS REFUSED: a write audited at or after the newest document, for a path not in the dump", () => {
  for (const at of ["2026-09-02 00:00:00", "2026-09-01 00:00:05"]) {
    withDump((dir) => {
      table(dir, "audit_log", [{ id: 1, action: "write", namespace: "sample", path: "mid-dump.md", at }]);
      assert.throws(() => checkDump(dir), /TORN.*audit_log 1 records a write to sample\/mid-dump\.md/);
    });
  }
});

test("an OLD write to a since-archived path is not torn, and is counted as an orphan", () => {
  withDump((dir) => {
    table(dir, "audit_log", [{ id: 1, action: "write", namespace: "sample", path: "archived/old.md", at: "2026-08-01 00:00:00" }]);
    assert.equal(checkDump(dir).orphanAudits, 1);
  });
});
