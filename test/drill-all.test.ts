import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { R2Like } from "@dustinedwards/d1-dump";
import { SITES, drillSite, firstFailure, selectSites } from "../scripts/drill-all.mjs";

// scripts/drill-all.mjs: the drill over a site's newest complete backup. The bucket is an
// in-memory R2Like and the drill is the REAL d1-dump CLI on its sqlite backend, so
// PASS and FAIL are the drill's own verdict. Fake data throughout.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const runIdOf = (iso: string) => iso.replace(/[:.]/g, "-");

const SCHEMA = [
  { type: "table", name: "documents", tbl_name: "documents", sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT, body TEXT)" },
  {
    type: "table",
    name: "documents_fts",
    tbl_name: "documents_fts",
    sql: "CREATE VIRTUAL TABLE documents_fts USING fts5(path, body, content='documents', content_rowid='id')",
  },
];

class FakeBucket {
  objects = new Map<string, string>();
  pageSize = 2;
  put = async (key: string, value: string) => void this.objects.set(key, value);
  get = async (key: string) => {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  };
  // Pages of pageSize keys, so the script has to follow the cursor.
  list = async ({ prefix = "", cursor }: { prefix?: string; cursor?: string }) => {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const objects = keys.slice(start, start + this.pageSize).map((key) => ({ key }));
    const next = start + this.pageSize;
    return { objects, truncated: next < keys.length, cursor: next < keys.length ? String(next) : undefined };
  };
  delete = async () => {};
  createMultipartUpload = async () => {
    throw new Error("unused");
  };
  asR2(): R2Like {
    return this as unknown as R2Like;
  }
}

// Writes a run the way d1-dump does: <table>.json, _schema.json, then _complete.json
// (last, and only when `complete`).
function plant(bucket: FakeBucket, exportedAt: string, rows: Array<Record<string, unknown>>, complete = true): string {
  const id = runIdOf(exportedAt);
  const prefix = `backups/json/${id}/`;
  const docKey = `${prefix}documents.json`;
  bucket.objects.set(docKey, JSON.stringify({ exported_at: exportedAt, table: "documents", rows }));
  bucket.objects.set(`${prefix}_schema.json`, JSON.stringify({ exported_at: exportedAt, schema: SCHEMA }));
  if (complete) {
    const tables = [{ name: "documents", rows: rows.length, key: docKey }];
    bucket.objects.set(
      `${prefix}_complete.json`,
      JSON.stringify({
        exported_at: exportedAt,
        keys: [docKey, `${prefix}_schema.json`],
        tables,
        fts: [{ name: "documents_fts", mode: "external", content: "documents" }],
        excluded: [],
      }),
    );
  }
  return id;
}

const DOCS = [
  { id: 1, path: "sample/alpha.md", body: "Notes about elephants and gardens" },
  { id: 2, path: "sample/beta.md", body: "Another sample document about lanterns" },
  { id: 3, path: "sample/gamma.md", body: "Third entry on bridges" },
];

test("SITES lists foxhound, carrel and germomics with their backup buckets", () => {
  assert.deepEqual(SITES, [
    { name: "foxhound", bucket: "foxhound-backups" },
    { name: "carrel", bucket: "carrel-backups" },
    { name: "germomics", bucket: "germomics-backups" },
  ]);
});

test("a good run: PASS with the marker's tables and rows and the age in hours", async () => {
  const bucket = new FakeBucket();
  const id = plant(bucket, hoursAgo(5.25), DOCS);
  const { line, ok } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.equal(line, `sample run=${id} age_hours=5.3 tables=1 rows=3 PASS`);
  assert.equal(ok, true);
});

test("a. the newest run has no _complete.json: the older complete run is drilled and passes", async () => {
  const bucket = new FakeBucket();
  const older = plant(bucket, hoursAgo(20), DOCS);
  const newer = plant(bucket, hoursAgo(2), DOCS, false);
  assert.ok(newer > older);
  const { line, ok } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.equal(line, `sample run=${older} age_hours=20.0 tables=1 rows=3 PASS`);
  assert.ok(!line.includes(newer));
  assert.equal(ok, true);
});

test("b. a complete run whose only table holds no rows: the drill fails its counts check", async () => {
  const bucket = new FakeBucket();
  const id = plant(bucket, hoursAgo(3), []);
  const { line, ok } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.match(line, new RegExp(`^sample run=${id} age_hours=3.0 tables=1 rows=0 FAIL \\(counts: `));
  assert.match(line, /the copy holds no rows at all/);
  assert.equal(ok, false);
});

test("a run older than the drill's 26 hour check fails on dump freshness", async () => {
  const bucket = new FakeBucket();
  plant(bucket, hoursAgo(40), DOCS);
  const { line, ok } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.match(line, /age_hours=40.0 tables=1 rows=3 FAIL \(dump: .*over 26h old\)$/);
  assert.equal(ok, false);
});

test("c. no complete run at all: a FAIL line, no throw", async () => {
  const bucket = new FakeBucket();
  plant(bucket, hoursAgo(2), DOCS, false);
  const { line, ok } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.equal(line, "sample FAIL (no complete run found)");
  assert.equal(ok, false);
  const empty = await drillSite("sample", new FakeBucket().asR2(), { now: NOW });
  assert.equal(empty.line, "sample FAIL (no complete run found)");
});

test("a bucket that cannot be read is a FAIL line with the reason", async () => {
  const broken = {
    list: async () => {
      throw new Error("Authentication error (10000)");
    },
    get: async () => null,
  } as unknown as R2Like;
  const { line, ok } = await drillSite("sample", broken, { now: NOW });
  assert.equal(line, "sample FAIL (Authentication error (10000))");
  assert.equal(ok, false);
});

test("the temp directory is removed after a site, pass or fail", async () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("drill-sample-"));
  const bucket = new FakeBucket();
  plant(bucket, hoursAgo(3), DOCS);
  await drillSite("sample", bucket.asR2(), { now: NOW });
  await drillSite("sample", new FakeBucket().asR2(), { now: NOW });
  assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith("drill-sample-")), before);
});

test("firstFailure names the first failing check, not the backend line", () => {
  const out = "backend: sqlite (asked)\nrestore drill FAILED: x\n  ok   dump: fine\n  FAIL counts: a has 0\n  FAIL fts: b\n";
  assert.equal(firstFailure(out), "counts: a has 0");
});

test("selectSites: all by default, --site limits, an unknown name throws", () => {
  assert.equal(selectSites([]).length, SITES.length);
  assert.deepEqual(selectSites(["--site", "carrel", "--site", "foxhound"]).map((s) => s.name), ["foxhound", "carrel"]);
  assert.throws(() => selectSites(["--site", "nope"]), /unknown site nope/);
  assert.throws(() => selectSites(["--site=carrel"]), /unknown argument --site=carrel/);
  assert.throws(() => selectSites(["--site"]), /--site needs a site name/);
});

test("a key that resolves outside the download directory is a FAIL line, never a write", async () => {
  const bucket = new FakeBucket();
  const id = plant(bucket, hoursAgo(3), DOCS);
  bucket.objects.set(`backups/json/${id}/../../../../escape.json`, "{}");
  const { line, ok } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.match(line, /FAIL \(.*resolves outside the download directory\)$/);
  assert.equal(ok, false);
});

test("the verdict reads the same clock as the printed age, not the wall clock", async () => {
  // NOW is a fixed past instant; a run 3h before it passes whatever today's date is.
  const bucket = new FakeBucket();
  plant(bucket, hoursAgo(3), DOCS);
  const { line } = await drillSite("sample", bucket.asR2(), { now: NOW });
  assert.match(line, /age_hours=3.0 tables=1 rows=3 PASS$/);
});
