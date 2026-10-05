// What a Capsid dump must hold that d1-dump's restore drill cannot know. The drill
// (npx d1-dump drill, run weekly by .github/workflows/restore-rehearsal.yml) restores
// the newest dump into a scratch D1 and checks counts against the marker, FTS5
// agreement, one search and the 100 KB statement cap. This script reads the same
// downloaded run directory and checks the rest, with no database:
//
// - _complete.json lists exactly the other files in the run.
// - Each table file's own "table" field matches its file name, so a copy shuffle cannot
//   restore rows into the wrong table, and every row of a table carries the same
//   columns, so a row that lost a nullable column is not restored as NULL.
// - The two sidecars (_kv.json, _holdout-manifests.json) are present, hold a non-empty
//   object of the right shape, and nothing else underscore-prefixed rides along that
//   nothing verifies. _schema.json and the marker are the only other two allowed.
// - documents is not empty: a gutted dump passes every count and proves nothing.
// - The dump is not TORN. It is one D1 batch, so its tables describe one instant.
//   Plain referential integrity is not checked: the live store holds orphaned version
//   and audit rows from deletions, path rewrites and a namespace rename, so orphans are
//   counted and reported. What fails is the pair of shapes a torn read produces and a
//   deletion cannot: a version row whose document_id is above the highest id in the
//   documents file with no delete or move recorded for its path, and a `write` audit
//   row at or after the newest document that names a path not in the documents file.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const COMPLETE_MARKER = "_complete.json";
export const SIDECARS = ["_holdout-manifests.json", "_kv.json"];
export const OPTIONAL_SIDECARS = ["_schema.json"];

function fail(reason) {
  const err = new Error(reason);
  err.invariant = true;
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

/**
 * @param {string} dumpDir one run directory: <table>.json files, sidecars and _complete.json
 * @returns {{ files: number, tables: number, rows: number, documents: number, orphanVersions: number, orphanAudits: number }}
 */
export function checkDump(dumpDir) {
  const files = readdirSync(dumpDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) fail(`${dumpDir} holds no JSON files; the check read nothing`);
  if (!files.includes(COMPLETE_MARKER)) fail(`${COMPLETE_MARKER} is missing, so this run is not a complete dump`);

  const marker = readJson(dumpDir, COMPLETE_MARKER);
  const listed = (Array.isArray(marker.keys) ? marker.keys : []).map((k) => String(k).split("/").pop()).sort();
  const present = files.filter((f) => f !== COMPLETE_MARKER).sort();
  if (listed.join(",") !== present.join(",")) {
    fail(`${COMPLETE_MARKER} lists ${listed.join(", ")} but the dump holds ${present.join(", ")}`);
  }

  const sidecars = files.filter((f) => f.startsWith("_") && f !== COMPLETE_MARKER).sort();
  const missing = SIDECARS.filter((f) => !sidecars.includes(f));
  const unknown = sidecars.filter((f) => !SIDECARS.includes(f) && !OPTIONAL_SIDECARS.includes(f));
  if (missing.length > 0) fail(`the dump is missing sidecars: ${missing.join(", ")}`);
  if (unknown.length > 0) fail(`the dump carries sidecars nothing verifies: ${unknown.join(", ")}`);
  // Present is not enough: `{}` exists too.
  checkSidecar(dumpDir, "_kv.json", "keys", (v) => v === null || typeof v === "string" || (typeof v === "object" && !Array.isArray(v) && typeof v.unreadable === "string"));
  checkSidecar(dumpDir, "_holdout-manifests.json", "manifests", (v) => v === null || (typeof v === "object" && !Array.isArray(v)));

  const tables = {};
  let rows = 0;
  for (const file of files.filter((f) => !f.startsWith("_"))) {
    const name = file.replace(/\.json$/, "");
    const parsed = readJson(dumpDir, file);
    if (parsed.table !== name) fail(`${file} says it dumps '${parsed.table}'; refusing to restore shuffled files`);
    if (!Array.isArray(parsed.rows)) fail(`${file} carries no rows array`);
    // src/backup.ts dumps SELECT *, so every row of a table has the same keys, null
    // columns included.
    const expected = parsed.rows.length > 0 ? Object.keys(parsed.rows[0]).sort().join(",") : "";
    parsed.rows.forEach((row, i) => {
      const keys = Object.keys(row ?? {}).sort().join(",");
      if (keys !== expected) fail(`${file} row ${i} does not carry the columns of row 0 (${keys} against ${expected})`);
    });
    tables[name] = parsed.rows;
    rows += parsed.rows.length;
  }

  const documents = tables.documents;
  if (!documents) fail("documents.json is missing");
  if (documents.length === 0) fail("the dump holds zero documents; a vacuous dump proves nothing");

  const versions = tables.document_versions ?? [];
  const audits = tables.audit_log ?? [];
  const docIds = new Set(documents.map((d) => d.id));
  const docKeys = new Set(documents.map((d) => `${d.namespace}\0${d.path}`));
  const removed = new Set(audits.filter((a) => a.action === "delete" || a.action === "move").map((a) => `${a.namespace}\0${a.path}`));
  const maxId = documents.reduce((m, d) => Math.max(m, d.id), 0);
  // Compared as strings, as the SQL it replaces compared them: both are "YYYY-MM-DD HH:MM:SS".
  const newest = documents.reduce((m, d) => (String(d.updated_at ?? "") > m ? String(d.updated_at ?? "") : m), "");

  const torn = [];
  for (const v of versions) {
    if (torn.length >= 5) break;
    if (v.document_id > maxId && !removed.has(`${v.namespace}\0${v.path}`)) {
      torn.push(`document_versions ${v.id} snapshots document ${v.document_id}, above the highest id in the documents file, and its path ${v.namespace}/${v.path} was never deleted or moved`);
    }
  }
  for (const a of audits) {
    if (torn.length >= 5) break;
    if (a.action === "write" && a.namespace != null && a.path != null && String(a.at ?? "") >= newest && !docKeys.has(`${a.namespace}\0${a.path}`)) {
      torn.push(`audit_log ${a.id} records a write to ${a.namespace}/${a.path} at ${a.at}, not before the newest document, and that document is not in the dump`);
    }
  }
  if (torn.length > 0) fail(`the dump is TORN: its tables do not describe one instant. ${torn.join("; ")}`);

  return {
    files: files.length,
    tables: Object.keys(tables).length,
    rows,
    documents: documents.length,
    orphanVersions: versions.filter((v) => !docIds.has(v.document_id)).length,
    orphanAudits: audits.filter((a) => a.namespace != null && a.path != null && !docKeys.has(`${a.namespace}\0${a.path}`)).length,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  const dumpDir = process.argv[2];
  if (!dumpDir) {
    console.error("usage: node scripts/dump-invariants.mjs <dump-run-directory>");
    process.exit(1);
  }
  try {
    const s = checkDump(dumpDir);
    console.log(
      `dump invariants PASSED: ${s.files} files, ${s.tables} tables, ${s.rows} rows, ${s.documents} documents, ` +
        `cross-table consistent (${s.orphanVersions} version and ${s.orphanAudits} audit rows reference documents no longer in the store, all explained by deletions, archiving or the namespace rename)`
    );
  } catch (e) {
    console.error(`dump invariants FAILED: ${e.message}`);
    process.exit(1);
  }
}
