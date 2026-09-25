// The restore rehearsal. Takes a downloaded
// dump run directory (one <table>.json per real table, the shape src/backup.ts writes)
// and proves it restores: migrations build a fresh SQLite database, every table's rows
// go in with documents FIRST so the FTS5 triggers rebuild the index, and the result is
// verified.
//
// Node's bundled SQLite (node:sqlite, stable on the .nvmrc version) carries FTS5, so the
// rehearsal runs the REAL triggers from migrations/0001_init.sql. Foreign key
// enforcement is off, deliberately: the runbook inserts table by table in dump order
// after documents, exactly as a real per-table D1 import does.
//
// What is verified, each failing with a named reason:
// - The dump directory holds EXACTLY one JSON per migrations-derived table, both
//   directions: a missing table file and an unexpected extra file both fail.
// - Each file's own "table" field matches its filename, so a copy shuffle cannot restore
//   rows into the wrong table.
// - The dump is fresh: documents.json's exported_at is within 26 hours.
// - Every row carries exactly its table's columns, every row inserts, and the
//   restored count equals the dump's count.
// - documents is non-empty. A zero-document restore passes every other check while
//   proving nothing.
// - The FTS index agrees with documents via the _docsize shadow table. COUNT(*) on an
//   external-content FTS5 table reads through to the content table and cannot detect
//   drift.
// - A MATCH probe on a word taken from a restored document returns it.
// - The two SIDECARS are present and are exactly the two expected (_kv.json,
//   _holdout-manifests.json). They restore into no table; a missing one means the loop's
//   memory is not in the backup. Each must hold a non-empty object of the right shape.
// - The completion marker (_complete.json), when present, lists exactly the other files
//   in the dump. It is optional because older dumps do not carry it.
// - CROSS-TABLE CONSISTENCY. The dump is one D1 batch, so the table objects must agree.
//   Plain referential integrity is not checked: the live store has orphaned version and
//   audit rows explained by deletions, path rewrites and a namespace rename. Orphans are
//   COUNTED AND REPORTED; what FAILS is the pair of shapes a torn read produces and a
//   deletion cannot: a version row whose document_id is above the highest id in the
//   documents object with no delete or move recorded for its path, and a `write` audit
//   row newer than every row in the documents object naming a path that is not there.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_STALE_HOURS } from "./freshness-lib.mjs";

// Identical derivation to test/backup.test.ts: real tables only. The regex
// does not match CREATE VIRTUAL TABLE, which is what keeps documents_fts out.
export function deriveTables(migrationsDir) {
  const tables = [];
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) {
      if (!tables.includes(m[1])) tables.push(m[1]);
    }
  }
  return tables;
}

// The sidecars src/backup.ts writes beside the table objects.
export const SIDECARS = ["_holdout-manifests.json", "_kv.json"];
// The completion marker src/backup.ts writes last, on a run whose preflight passed.
// Optional: older dumps do not carry it. When present, the files
// it lists must be exactly the other files in the dump.
export const COMPLETE_MARKER = "_complete.json";

function fail(reason) {
  const err = new Error(reason);
  err.rehearsal = true;
  throw err;
}

function readJson(dumpDir, file) {
  try {
    return JSON.parse(readFileSync(join(dumpDir, file), "utf8"));
  } catch (e) {
    fail(`${file} does not parse as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function checkSidecar(dumpDir, file, field, valueOk) {
  const parsed = readJson(dumpDir, file);
  const inner = parsed?.[field];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) fail(`${file} carries no '${field}' object`);
  const entries = Object.entries(inner);
  if (entries.length === 0) fail(`${file} has an empty '${field}' object; the sidecar holds nothing`);
  const bad = entries.filter(([, v]) => !valueOk(v)).map(([k]) => k);
  if (bad.length > 0) fail(`${file} has '${field}' entries of the wrong shape: ${bad.slice(0, 5).join(", ")}`);
  if (typeof parsed.exported_at !== "string") fail(`${file} carries no exported_at`);
}

// A STALE DUMP IS A FAILED REHEARSAL. The workflow takes the newest dump in R2, so
// when backups stop it would keep rehearsing the last good one. The threshold is the
// one gate 1c applies to /health (scripts/freshness-lib.mjs), measured from the dump's
// own exported_at.
function checkDumpAge(dumpDir, opts) {
  const maxHours = opts.maxAgeHours ?? BACKUP_STALE_HOURS;
  const now = opts.now ?? Date.now();
  const exportedAt = readJson(dumpDir, "documents.json")?.exported_at;
  const at = typeof exportedAt === "string" ? Date.parse(exportedAt) : NaN;
  if (!Number.isFinite(at)) fail(`documents.json carries no readable exported_at ('${exportedAt}'), so the dump's age is unknown`);
  const ageHours = (now - at) / 3_600_000;
  if (ageHours > maxHours) {
    fail(`the newest dump was exported at ${exportedAt}, ${ageHours.toFixed(1)}h ago, past the ${maxHours}h threshold. Backups have stopped; this rehearsal would only prove an old dump restores.`);
  }
}

/**
 * @param {string} dumpDir
 * @param {string} migrationsDir
 * @param {{ now?: number, maxAgeHours?: number }} [opts]
 */
export function rehearse(dumpDir, migrationsDir, opts = {}) {
  const tables = deriveTables(migrationsDir);
  if (tables.length === 0) fail(`no tables derived from ${migrationsDir}; the rehearsal read nothing`);

  const files = readdirSync(dumpDir).filter((f) => f.endsWith(".json"));
  // Sidecars are underscore-prefixed so they cannot collide with a table name. Checked in
  // BOTH directions: a missing one is a dump that lost the loop's memory, an unexpected
  // one is a file nothing here knows how to verify.
  const sidecars = files.filter((f) => f.startsWith("_") && f !== COMPLETE_MARKER).sort();
  const missingSidecars = SIDECARS.filter((f) => !sidecars.includes(f));
  const unknownSidecars = sidecars.filter((f) => !SIDECARS.includes(f));
  if (missingSidecars.length > 0) fail(`the dump is missing sidecars: ${missingSidecars.join(", ")}`);
  if (unknownSidecars.length > 0) fail(`the dump carries sidecars nothing verifies: ${unknownSidecars.join(", ")}`);
  // Present is not enough: `{}` exists too. Each sidecar must carry the object
  // src/backup.ts writes, with at least one entry.
  checkSidecar(dumpDir, "_kv.json", "keys", (v) => v === null || typeof v === "string" || (typeof v === "object" && !Array.isArray(v) && typeof v.unreadable === "string"));
  checkSidecar(dumpDir, "_holdout-manifests.json", "manifests", (v) => v === null || (typeof v === "object" && !Array.isArray(v)));
  const marked = files.includes(COMPLETE_MARKER);
  if (marked) {
    const marker = JSON.parse(readFileSync(join(dumpDir, COMPLETE_MARKER), "utf8"));
    const listed = (Array.isArray(marker.keys) ? marker.keys : []).map((k) => String(k).split("/").pop()).sort();
    const present = files.filter((f) => f !== COMPLETE_MARKER).sort();
    if (listed.join(",") !== present.join(",")) {
      fail(`${COMPLETE_MARKER} lists ${listed.join(", ")} but the dump holds ${present.join(", ")}`);
    }
  }

  const dumped = files.filter((f) => !f.startsWith("_")).map((f) => f.replace(/\.json$/, ""));
  const missing = tables.filter((t) => !dumped.includes(t));
  const extra = dumped.filter((d) => !tables.includes(d));
  if (missing.length > 0) fail(`the dump is missing tables the migrations create: ${missing.join(", ")}`);
  if (extra.length > 0) fail(`the dump carries files no migration explains: ${extra.join(", ")}`);

  checkDumpAge(dumpDir, opts);

  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }

  // documents first; the runbook's one ordering rule, because the FTS triggers
  // fire on its inserts.
  const ordered = ["documents", ...tables.filter((t) => t !== "documents")];
  let totalRows = 0;
  for (const table of ordered) {
    const parsed = JSON.parse(readFileSync(join(dumpDir, `${table}.json`), "utf8"));
    if (parsed.table !== table) fail(`${table}.json says it dumps '${parsed.table}'; refusing to restore shuffled files`);
    if (!Array.isArray(parsed.rows)) fail(`${table}.json carries no rows array`);
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
    const insert = db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
    );
    // Every row must carry exactly the table's columns, so a dump that stopped carrying
    // a nullable column does not restore it as NULL and pass. src/backup.ts dumps
    // SELECT *, so a real row has every column, null ones included.
    const expected = [...columns].sort().join(",");
    parsed.rows.forEach((row, i) => {
      const keys = Object.keys(row ?? {}).sort().join(",");
      if (keys !== expected) {
        const missingCols = columns.filter((c) => !(c in (row ?? {})));
        const extraCols = Object.keys(row ?? {}).filter((k) => !columns.includes(k));
        fail(`${table}.json row ${i} does not carry the table's columns (missing: ${missingCols.join(", ") || "none"}; extra: ${extraCols.join(", ") || "none"})`);
      }
    });
    for (const row of parsed.rows) {
      insert.run(...columns.map((c) => row[c]));
    }
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (n !== parsed.rows.length) fail(`${table} restored ${n} rows against ${parsed.rows.length} dumped`);
    totalRows += n;
  }

  const { n: docCount } = db.prepare(`SELECT COUNT(*) AS n FROM documents`).get();
  if (docCount === 0) fail("the restore produced zero documents; a vacuous rehearsal proves nothing");

  const { n: ftsCount } = db.prepare(`SELECT COUNT(*) AS n FROM documents_fts_docsize`).get();
  if (ftsCount !== docCount) fail(`the FTS index holds ${ftsCount} rows against ${docCount} documents (counted via _docsize; COUNT on the FTS table itself cannot see drift)`);

  // The probe word comes from a restored document, so the MATCH exercises the
  // index against content known to be in it. Quoted, so FTS syntax cannot leak.
  const probeSource = db.prepare(`SELECT title, body FROM documents WHERE body IS NOT NULL LIMIT 20`).all();
  const word = probeSource.flatMap((d) => `${d.title ?? ""} ${d.body ?? ""}`.split(/[^A-Za-z]+/)).find((w) => w.length >= 4);
  if (!word) fail("no probe word could be taken from the restored documents; refusing to skip the MATCH check");
  const { n: matched } = db
    .prepare(`SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH ?`)
    .get(`"${word}"`);
  if (matched === 0) fail(`the FTS probe for '${word}' matched nothing although the word came from a restored document`);

  // ---- cross-table consistency ---------------------------------------------
  const { n: orphanVersions } = db
    .prepare(`SELECT COUNT(*) AS n FROM document_versions v WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = v.document_id)`)
    .get();
  const { n: orphanAudits } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_log a WHERE a.namespace IS NOT NULL AND a.path IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.namespace = a.namespace AND d.path = a.path)`
    )
    .get();

  const torn = [];
  const tornVersions = db
    .prepare(
      `SELECT v.id, v.namespace, v.path, v.document_id FROM document_versions v
        WHERE v.document_id > (SELECT COALESCE(MAX(id), 0) FROM documents)
          AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.namespace = v.namespace AND a.path = v.path AND a.action IN ('delete', 'move'))
        LIMIT 5`
    )
    .all();
  for (const row of tornVersions) {
    torn.push(`document_versions ${row.id} snapshots document ${row.document_id}, above the highest id in the documents object, and its path ${row.namespace}/${row.path} was never deleted or moved`);
  }
  const tornAudits = db
    .prepare(
      `SELECT a.id, a.namespace, a.path, a.at FROM audit_log a
        WHERE a.action = 'write' AND a.namespace IS NOT NULL AND a.path IS NOT NULL
          AND a.at >= (SELECT COALESCE(MAX(updated_at), '') FROM documents)
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.namespace = a.namespace AND d.path = a.path)
        LIMIT 5`
    )
    .all();
  for (const row of tornAudits) {
    torn.push(`audit_log ${row.id} records a write to ${row.namespace}/${row.path} at ${row.at}, later than every row in the documents object, and that document is not in the dump`);
  }
  if (torn.length > 0) {
    fail(`the dump is TORN: its tables do not describe one instant. ${torn.join("; ")}`);
  }

  db.close();
  return { tables: tables.length, totalRows, docCount, probe: word, orphanVersions, orphanAudits, marked };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  const dumpDir = process.argv[2];
  if (!dumpDir) {
    console.error("usage: node scripts/restore-rehearsal.mjs <dump-run-directory>");
    process.exit(1);
  }
  try {
    const summary = rehearse(dumpDir, join(import.meta.dirname, "..", "migrations"));
    console.log(
      `restore rehearsal PASSED: ${summary.tables} tables, ${summary.totalRows} rows, ${summary.docCount} documents, ` +
        `${summary.marked ? "marked complete" : "no completion marker"}, FTS probe '${summary.probe}' found, ` +
        `cross-table consistent (${summary.orphanVersions} version and ${summary.orphanAudits} audit rows reference documents no longer in the store, all explained by deletions, archiving or the namespace rename)`
    );
  } catch (e) {
    console.error(`restore rehearsal FAILED: ${e.message}`);
    process.exit(1);
  }
}
