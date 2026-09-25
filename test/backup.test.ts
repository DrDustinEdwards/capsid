import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runBackup, TABLES } from "../src/backup.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, type FakeD1Options } from "./fakes.ts";

// FTS5 derives documents_fts from documents and the sync triggers rebuild it on
// import, so the virtual table and its shadow tables are never exported.
const DERIVED = /^(documents_fts|sqlite_)/;

function tablesInMigrations(): string[] {
  const dir = join(import.meta.dirname, "..", "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    // CREATE VIRTUAL TABLE does not match, which keeps documents_fts out.
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) {
      if (!DERIVED.test(m[1])) names.add(m[1]);
    }
  }
  return [...names].sort();
}

test("the migrations parse to a non-empty table list", () => {
  // Guards the regex itself: a parser that silently matches nothing would make
  // every assertion below vacuously pass.
  assert.ok(tablesInMigrations().length >= 5);
});

test("every table the migrations create is backed up", () => {
  const missing = tablesInMigrations().filter((t) => !TABLES.includes(t as (typeof TABLES)[number]));
  assert.deepEqual(missing, [], `migrations create tables that src/backup.ts does not export: ${missing.join(", ")}`);
});

test("every backed-up table exists in the migrations", () => {
  const inMigrations = tablesInMigrations();
  const unknown = TABLES.filter((t) => !inMigrations.includes(t));
  assert.deepEqual(unknown, [], `src/backup.ts exports tables no migration creates: ${unknown.join(", ")}`);
});

// ---- the run itself ---------------------------------------------------------
//
// FAKES, AND WHY THEY ARE SHAPED THIS WAY (audit 2 batch B). There was no fake R2 in
// this repo, so one is added here and it is written to be capable of the thing under
// test: it holds real state and it RECORDS EVERY DELETE. A bucket that cannot express a
// delete would make "refuses to delete the mirror" pass whether or not anything was
// refused, which is the vacuous-guard shape.
//
// The fake D1 answers three shapes: SELECT * FROM <table> (the export), the pinned
// FTS probe (the preflight), and the count-then-delete batch. Its batch deliberately
// reports an INFLATED meta.changes, because that is what D1 does here (the FTS5
// triggers inflate it) and it is the number the run must NOT be reading.

// The fakes are shared now (quality audit 6.2). What used to be three local
// implementations here is one import; the capabilities this file relied on
// (recorded deletes per call, recorded puts with their ttl, an FTS probe that can
// miss, inflated meta.changes on the prune batch) all survive in the merged
// version, and it gained cursor pagination, which no fake had.

function makeEnv(dbOpts: FakeD1Options, seedR2: Record<string, string> = {}, seedKv: Record<string, string> = {}) {
  const r2 = fakeR2(seedR2);
  const kv = fakeKv({ seed: seedKv });
  const { db, batches } = fakeD1(dbOpts);
  return { env: fakeEnv({ DB: db, MEDIA: r2.bucket, APP_KV: kv.kv }), r2, kv, batches };
}

// Captures console.error so a test can assert the run was LOUD, not just that it
// returned a field.
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

const DOCS = [
  { namespace: "capsid", path: "core.md", body: "core" },
  { namespace: "capsid", path: "conventions.md", body: "conventions" },
];
const MIRROR = {
  "backups/markdown/capsid/core.md": "core",
  "backups/markdown/capsid/conventions.md": "conventions",
  "backups/markdown/capsid/deleted-yesterday.md": "gone",
};

test("a healthy run dumps one object per table, keyed by TABLES", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  // Derived from TABLES in both directions: a table added to the export without an
  // object, or an object with no table, fails here. The two underscore-prefixed
  // sidecars (the KV pins and the holdout manifests) are named explicitly rather
  // than matched by shape, so dropping one is a failure here too. A clean run also
  // writes the completion marker.
  const expected = [
    ...TABLES.map((t) => `${result.json_prefix}${t}.json`),
    `${result.json_prefix}_kv.json`,
    `${result.json_prefix}_holdout-manifests.json`,
    `${result.json_prefix}_complete.json`,
  ].sort();
  assert.deepEqual([...result.json_keys].sort(), expected);
  assert.deepEqual([...r2.objects.keys()].filter((k) => k.startsWith(result.json_prefix)).sort(), expected);
  // Each object carries its own table's rows, not the whole database.
  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}documents.json`) as string);
  assert.equal(dumped.table, "documents");
  assert.equal(dumped.rows.length, 2);
});

test("a healthy run prunes genuinely stale markdown and keeps the current mirror", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.prune_refused, null);
  assert.equal(result.markdown_pruned, 1);
  assert.deepEqual(r2.deleted.flat(), ["backups/markdown/capsid/deleted-yesterday.md"]);
  assert.ok(r2.objects.has("backups/markdown/capsid/core.md"));
  assert.ok(r2.objects.has("backups/markdown/capsid/conventions.md"));
});

test("an empty documents read refuses the prune, loudly, and deletes nothing", async () => {
  // The dangerous case: the SELECT SUCCEEDS and returns no rows. Every mirror object
  // is then "stale" and the old code deleted all of them in one call.
  const { env, r2 } = makeEnv({ documents: [] }, MIRROR);
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.prune_refused, "documents-empty");
  assert.equal(result.preflight.documents, 0);
  assert.deepEqual(r2.deleted, [], "the refused run deleted objects");
  for (const key of Object.keys(MIRROR)) assert.ok(r2.objects.has(key), `${key} was wiped`);
  // Loud, and named, so a log search finds it without knowing the wording.
  assert.ok(logged.some((line) => line.includes("BACKUP_PREFLIGHT_REFUSED")), logged.join("\n"));
  // The dumps are still written: an export deletes nothing, and an empty dump is
  // the evidence of the day the store looked empty.
  assert.equal(result.json_keys.length, TABLES.length + 2);
  for (const key of result.json_keys) assert.ok(r2.objects.has(key));
  // A refused run is not marked complete, so it takes no slot in the retention floor.
  assert.equal(r2.objects.has(`${result.json_prefix}_complete.json`), false, "a refused run was marked complete");
});

test("a failing FTS probe refuses the prune even when documents has rows", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS, ftsHit: false }, MIRROR);
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.match(result.prune_refused ?? "", /^fts-probe-failed/);
  assert.deepEqual(r2.deleted, []);
  assert.ok(logged.some((line) => line.includes("BACKUP_PREFLIGHT_REFUSED")));
});

test("a second concurrent runner exits named and touches nothing", async () => {
  const { env, r2, kv, batches } = makeEnv({ documents: DOCS }, MIRROR, {
    "backup:lease": "2026-08-17T09:00:00.000Z",
  });
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, false);
  if (result.ran) return;

  assert.equal(result.skipped, "lease-held");
  assert.deepEqual(r2.deleted, []);
  assert.deepEqual(batches, [], "the skipped run still pruned D1");
  assert.deepEqual(kv.puts, [], "the skipped run took the lease anyway");
  // The first run's lease survives: a loser must not release a lease it never held.
  assert.equal(kv.store.get("backup:lease"), "2026-08-17T09:00:00.000Z");
  assert.ok(logged.some((line) => line.includes("BACKUP_LEASE_HELD")));
});

test("the lease carries an expiry and is released when the run ends", async () => {
  const { env, kv } = makeEnv({ documents: DOCS }, MIRROR);
  await runBackup(env);
  // A clean run puts twice: the lease (with a ttl) and backup:last-ok (without).
  const lease = kv.puts.find((p) => p.key === "backup:lease");
  assert.ok(lease, "the lease was never taken");
  // A crashed run must not wedge backups forever, so the lease cannot be eternal,
  // and KV will not accept a TTL under 60 seconds.
  assert.ok((lease.ttl ?? 0) >= 60, "lease has no usable expiry");
  assert.equal(kv.store.has("backup:lease"), false, "lease was not released");
});

test("the lease is released even when the run throws", async () => {
  const { env, kv } = makeEnv({ documents: DOCS }, MIRROR);
  (env as unknown as { MEDIA: R2Bucket }).MEDIA = {
    put: async () => {
      throw new Error("r2 exploded");
    },
  } as unknown as R2Bucket;
  await assert.rejects(() => runBackup(env), /r2 exploded/);
  // Both halves, or this passes by reading nothing: a run that never took a lease
  // also leaves no lease behind.
  assert.equal(kv.puts.length, 1, "the run never took a lease");
  assert.equal(kv.store.has("backup:lease"), false, "the lease outlived the failed run");
});

test("versions_pruned and audit_pruned come from a COUNT, not meta.changes", async () => {
  const { env, batches } = makeEnv({ documents: DOCS, dueCounts: [3, 7] }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  // The fake reports meta.changes 999 on every statement, which is what D1 does here
  // (FTS5 triggers inflate it). Reading it would show 999.
  assert.equal(result.versions_pruned, 3);
  assert.equal(result.audit_pruned, 7);
  // The count and the delete must carry the identical predicate, or the count is of
  // a different set of rows than the one that leaves. TWO batches now: the export
  // snapshot and this one. The prune batch is found by what it contains rather than
  // by position, so a third batch cannot silently retarget these assertions.
  const pruneBatch = batches.find((b) => b.some((sql) => sql.startsWith("DELETE FROM document_versions")));
  assert.ok(pruneBatch, "no batch carried the prune");
  const [countVersions, deleteVersions, countAudit, deleteAudit] = pruneBatch;
  assert.match(countVersions, /^SELECT COUNT\(\*\) AS n FROM document_versions WHERE snapshot_at < /);
  assert.equal(deleteVersions.replace(/^DELETE FROM/, "SELECT COUNT(*) AS n FROM"), countVersions);
  assert.match(countAudit, /^SELECT COUNT\(\*\) AS n FROM audit_log WHERE at < /);
  assert.equal(deleteAudit.replace(/^DELETE FROM/, "SELECT COUNT(*) AS n FROM"), countAudit);
});

test("dump retention keeps the newest runs whole, counting runs and not objects", async () => {
  // 20 aged-out runs of five objects each. If the floor counted OBJECTS it would
  // keep 14 of 100, which is under three runs; it must keep 14 RUNS.
  const seed: Record<string, string> = { ...MIRROR };
  const runIds: string[] = [];
  for (let day = 1; day <= 20; day++) {
    const id = `2020-01-${String(day).padStart(2, "0")}T00-00-00-000Z`;
    runIds.push(id);
    for (const table of TABLES) seed[`backups/json/${id}/${table}.json`] = "{}";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  // 21 runs exist once this run writes its own, the floor keeps the newest 14, and
  // the 7 left over are all past the cutoff, so they age out whole.
  assert.equal(result.json_backups_pruned, 7);
  assert.equal(result.json_backups_kept, 14);
  const deletedDumps = r2.deleted.flat().filter((k) => k.startsWith("backups/json/"));
  assert.equal(deletedDumps.length, 7 * TABLES.length);
  const survivors = runIds.filter((id) => [...r2.objects.keys()].some((k) => k.startsWith(`backups/json/${id}/`)));
  assert.deepEqual(survivors, runIds.slice(7), "a run was half-deleted or the wrong runs aged out");
  // And a surviving run keeps every one of its objects, not just some.
  for (const id of survivors) {
    for (const table of TABLES) assert.ok(r2.objects.has(`backups/json/${id}/${table}.json`));
  }
});

test("a pre-change flat dump key ages as its own single-object run", async () => {
  // Objects written before the per-table split have no slash after the prefix. They
  // must still age out rather than sit forever or drag a whole day down with them.
  const seed: Record<string, string> = { ...MIRROR };
  for (let day = 1; day <= 20; day++) {
    seed[`backups/json/2020-01-${String(day).padStart(2, "0")}T00-00-00-000Z.json`] = "{}";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.json_backups_pruned, 7);
  assert.equal(r2.deleted.flat().filter((k) => k.startsWith("backups/json/")).length, 7);
});

test("a clean run stamps backup:last-ok with the run timestamp", async () => {
  const { env, kv } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;
  const stamp = kv.puts.find((p) => p.key === "backup:last-ok");
  assert.ok(stamp, "a clean run did not stamp backup:last-ok");
  // The stamp is the same ISO instant the run used for its lease and dump prefix,
  // so /health's age is measured from when the backup actually ran.
  assert.match(stamp.value, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("a preflight-refused run does NOT stamp backup:last-ok", async () => {
  // A run that would not trust its own read of the store must not report itself as
  // a fresh backup, or /health would go quiet on exactly the day it should warn.
  const { env, kv } = makeEnv({ documents: [] }, MIRROR);
  await captureErrors(() => runBackup(env));
  assert.equal(kv.puts.some((p) => p.key === "backup:last-ok"), false, "a refused run stamped itself as fresh");
});

// ---- the 1000-key delete ceiling (residual 5) --------------------------------
//
// R2's bulk delete takes at most 1000 keys per call and throws on the 1001st. All
// three of the run's deletes handed it an unbounded array, so the first day the
// mirror shed more than a thousand documents, or the day a backlog of aged dumps
// came due, the backup threw AFTER writing its dumps and BEFORE stamping
// backup:last-ok. The failure would have been loud, which is the only good part.
//
// 1001 rather than a round 1000 because the boundary is where an off-by-one lives:
// a chunker written with `<` instead of `<=` passes at exactly 1000.
const R2_DELETE_CEILING = 1000;

test("no single R2 delete call exceeds R2's 1000-key ceiling", async () => {
  const seed: Record<string, string> = {};
  for (let i = 0; i < 1001; i++) {
    seed[`backups/markdown/capsid/stale-${String(i).padStart(5, "0")}.md`] = "gone";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const oversized = r2.deleted.filter((call) => call.length > R2_DELETE_CEILING);
  assert.deepEqual(
    oversized.map((call) => call.length),
    [],
    `an R2 delete call carried more than ${R2_DELETE_CEILING} keys, which R2 refuses`
  );
  // NOT VACUOUS: the chunking must still delete everything it was asked to. A
  // chunker that dropped the tail would satisfy the assertion above.
  assert.equal(result.markdown_pruned, 1001);
  const leftover = [...r2.objects.keys()].filter((k) => k.includes("/stale-"));
  assert.deepEqual(leftover, [], "chunking lost keys: stale mirror objects survived the prune");
});

test("the dump prune chunks too, not just the mirror", async () => {
  // 22 aged runs x 10 tables is 220 keys, which is under the ceiling, so the dump
  // prune is exercised for CHUNK SHAPE rather than for overflow: every call it
  // makes must come from the same chunker. The guard is that the run's delete
  // calls are all within the ceiling AND that the aged dumps are all gone.
  const seed: Record<string, string> = { ...MIRROR };
  for (let day = 1; day <= 22; day++) {
    const id = `2020-01-${String(day).padStart(2, "0")}T00-00-00-000Z`;
    for (const table of TABLES) seed[`backups/json/${id}/${table}.json`] = "{}";
  }
  for (let i = 0; i < 1200; i++) {
    seed[`reports/csp/2020-01-01/${String(i).padStart(5, "0")}.json`] = "{}";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.deepEqual(r2.deleted.filter((c) => c.length > R2_DELETE_CEILING).map((c) => c.length), []);
  assert.equal(result.reports_pruned, 1200);
  assert.deepEqual([...r2.objects.keys()].filter((k) => k.startsWith("reports/csp/")), []);
});

// ---- one consistent snapshot (residual 4) -----------------------------------
//
// The export used to be a `for` loop of `SELECT * FROM <table>`, each its own
// round trip. Ten reads at ten different instants is ten snapshots, not one: a
// write landing between the documents read and the document_versions read puts a
// version row in the dump whose document is not in it, and NOTHING could see that
// afterwards. D1's batch is one transaction, so the ten reads now agree with each
// other by construction and `exported_at` is finally true rather than decorative.

test("every table read whole is read at ONE instant, however many writes land between D1 calls", async () => {
  // A concurrent writer adds one row to every whole-read table before EACH call the run
  // makes to D1, tagged with a generation number. Tables read in one batch all carry
  // the same last generation; tables read in separate round trips carry different ones.
  // document_versions and audit_log are paged after the batch and have their own
  // one-instant tests below.
  const r2 = fakeR2(MIRROR);
  const kv = fakeKv({});
  const d1 = fakeD1({ documents: DOCS });
  let generation = 0;
  // Each write REPLACES the table's array rather than pushing onto it: the fake hands a
  // read the live array, and a later push would reach into a result already returned.
  const write = () => {
    generation += 1;
    const gen = `gen-${generation}`;
    const rows = d1.rows;
    rows.documents = [...rows.documents, { id: 1000 + generation, namespace: "capsid", path: `${gen}.md`, body: gen }];
    rows.namespaces = [...rows.namespaces, { namespace: gen, repos: "[]" }];
    rows.links = [...rows.links, { from_ns: "capsid", from_path: `${gen}.md`, type: "references", to_ns: "capsid", to_path: "core.md" }];
    rows.agents = [...rows.agents, { id: gen, name: gen }];
    rows.jobs = [...rows.jobs, { id: gen, namespace: "capsid", title: gen, status: "queued" }];
  };
  type Stmt = { sql: string; params: unknown[]; bind: (...a: unknown[]) => Stmt; first: () => Promise<unknown>; all: () => Promise<unknown>; run: () => Promise<unknown> };
  const wrap = (s: Stmt): Stmt => ({
    ...s,
    bind: (...a: unknown[]) => wrap(s.bind(...a)),
    first: async () => (write(), s.first()),
    all: async () => (write(), s.all()),
    run: async () => (write(), s.run()),
  });
  const db = d1.db as unknown as { prepare: (sql: string) => Stmt; batch: (s: Stmt[]) => Promise<unknown> };
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  db.prepare = (sql: string) => wrap(prepare(sql));
  db.batch = async (statements: Stmt[]) => (write(), batch(statements));

  const result = await runBackup(fakeEnv({ DB: d1.db, MEDIA: r2.bucket, APP_KV: kv.kv }));
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const lastGeneration = (table: string): number => {
    const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}${table}.json`) as string) as { rows: Array<Record<string, unknown>> };
    const gens = dumped.rows.flatMap((r) => Object.values(r).map((v) => String(v).match(/^gen-(\d+)/)?.[1]).filter((g) => g !== undefined)).map(Number);
    assert.ok(gens.length > 0, `${table} carries no writer row, so this compares nothing`);
    return Math.max(...gens);
  };
  const whole = ["documents", "namespaces", "document_links", "agents", "jobs"];
  assert.ok(whole.every((t) => (TABLES as readonly string[]).includes(t)), "a table this test seeds is no longer exported");
  const seen = Object.fromEntries(whole.map((t) => [t, lastGeneration(t)]));
  assert.equal(new Set(Object.values(seen)).size, 1, `the tables were read at different instants: ${JSON.stringify(seen)}`);
});

// ---- audit_log is paged too (audit finding F1-3, 2026-09-25) -------------------
//
// audit_log is kept 180 days and was the next table read whole. It is append-only with
// an AUTOINCREMENT id, so the same MAX(id) bound keeps the snapshot one instant.

function auditRow(id: number) {
  return { id, namespace: "capsid", path: "core.md", actor: "operator", action: "write", params: "{}", at: "2026-09-01 00:00:00" };
}

test("audit_log is streamed in pages, every row once and in id order, in the same file shape", async () => {
  // 2500 rows is two full pages of 1000 and a partial one, seeded out of order.
  const audit = Array.from({ length: 2500 }, (_, i) => auditRow(2500 - i));
  const { env, r2, batches } = makeEnv({ documents: DOCS, auditLog: audit }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const key = `${result.json_prefix}audit_log.json`;
  assert.ok(r2.multipart.some((m) => m.key === key), "audit_log was not written as a multipart upload");
  const exportedAt = JSON.parse(r2.objects.get(`${result.json_prefix}documents.json`) as string).exported_at;
  const sorted = [...audit].sort((a, b) => a.id - b.id);
  assert.equal(r2.objects.get(key), JSON.stringify({ exported_at: exportedAt, table: "audit_log", rows: sorted }));
  const exportBatch = batches.find((b) => b.includes("SELECT * FROM documents"));
  assert.ok(exportBatch && !exportBatch.includes("SELECT * FROM audit_log"), "audit_log was read whole inside the batch");
});

test("an audit row written after the snapshot batch is not in the dump", async () => {
  const r2 = fakeR2(MIRROR);
  const kv = fakeKv({});
  const d1 = fakeD1({ documents: DOCS, auditLog: [auditRow(1), auditRow(2)] });
  const batch = d1.db.batch.bind(d1.db);
  let first = true;
  (d1.db as unknown as { batch: typeof batch }).batch = (async (statements: Parameters<typeof batch>[0]) => {
    const out = await batch(statements);
    if (first) {
      first = false;
      d1.rows.audit_log.push(auditRow(3));
    }
    return out;
  }) as typeof batch;
  const env = fakeEnv({ DB: d1.db, MEDIA: r2.bucket, APP_KV: kv.kv });
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}audit_log.json`) as string);
  assert.deepEqual(dumped.rows.map((r: { id: number }) => r.id), [1, 2]);
});

// ---- the streamed table (2026-09-23, job_be450271dfa9) ------------------------
//
// From 2026-09-20 the cron wrote nothing: 96.4MB of database, 66.5MB of it version
// bodies, read in one batch into a 128MB isolate. document_versions is now paged
// and written as a multipart upload. These tests hold the three things that change
// must not lose: the file is byte-identical to the old one, no row is dropped at a
// page or part boundary, and the snapshot is still one instant.

function version(id: number, body: string) {
  return { id, document_id: 1, namespace: "capsid", path: "core.md", title: "t", body, snapshot_at: "2026-09-01 00:00:00" };
}

test("the streamed versions dump is byte-identical to the whole-object dump, across several parts", async () => {
  // Three 7MB bodies make a ~21MB file, which crosses two 8MiB part boundaries,
  // one of them inside a row.
  const versions = [1, 2, 3].map((id) => version(id, String.fromCharCode(96 + id).repeat(7 * 1024 * 1024)));
  const { env, r2 } = makeEnv({ documents: DOCS, versions }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const key = `${result.json_prefix}document_versions.json`;
  const exportedAt = JSON.parse(r2.objects.get(`${result.json_prefix}documents.json`) as string).exported_at;
  assert.equal(r2.objects.get(key), JSON.stringify({ exported_at: exportedAt, table: "document_versions", rows: versions }));
  const upload = r2.multipart.find((m) => m.key === key);
  assert.ok(upload, "document_versions was not written as a multipart upload");
  assert.equal(upload.parts.length, 3, `expected three parts, got ${upload.parts.join(",")}`);
});

test("the streamed versions dump pages past one page and keeps every row in id order", async () => {
  // 250 rows is two full pages of 100 and a partial one. Seeded out of order, so a
  // pager that did not ORDER BY id would skip rows at the boundary.
  const versions = Array.from({ length: 250 }, (_, i) => version(250 - i, `v${250 - i}`));
  const { env, r2 } = makeEnv({ documents: DOCS, versions }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}document_versions.json`) as string);
  assert.deepEqual(
    dumped.rows.map((r: { id: number }) => r.id),
    Array.from({ length: 250 }, (_, i) => i + 1)
  );
});

test("an empty versions table still writes a valid dump", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS, versions: [] }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;
  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}document_versions.json`) as string);
  assert.equal(dumped.table, "document_versions");
  assert.deepEqual(dumped.rows, []);
});

test("a version written after the snapshot batch is not in the dump", async () => {
  // The bound is what keeps the dump one instant. Without it, a version written
  // between the batch and the pages would be in the dump while the document write
  // that caused it was not, which is the torn shape the restore rehearsal checks for.
  const r2 = fakeR2(MIRROR);
  const kv = fakeKv({});
  const d1 = fakeD1({ documents: DOCS, versions: [version(1, "a"), version(2, "b")] });
  const batch = d1.db.batch.bind(d1.db);
  let first = true;
  (d1.db as unknown as { batch: typeof batch }).batch = (async (statements: Parameters<typeof batch>[0]) => {
    const out = await batch(statements);
    if (first) {
      first = false;
      d1.rows.versions.push(version(3, "written after the snapshot"));
    }
    return out;
  }) as typeof batch;
  const env = fakeEnv({ DB: d1.db, MEDIA: r2.bucket, APP_KV: kv.kv });
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}document_versions.json`) as string);
  assert.deepEqual(dumped.rows.map((r: { id: number }) => r.id), [1, 2]);
});

test("a failed part aborts the multipart upload and fails the run", async () => {
  const { env, r2, kv } = makeEnv({ documents: DOCS, versions: [version(1, "a")] }, MIRROR);
  const create = r2.bucket.createMultipartUpload.bind(r2.bucket);
  (r2.bucket as unknown as { createMultipartUpload: typeof create }).createMultipartUpload = (async (
    ...args: Parameters<typeof create>
  ) => {
    const upload = await create(...args);
    return { ...upload, uploadPart: async () => { throw new Error("part refused"); } };
  }) as typeof create;
  await assert.rejects(() => runBackup(env), /part refused/);
  assert.equal(r2.multipart.at(-1)?.aborted, true, "the failed upload was left open");
  assert.equal(kv.puts.some((p) => p.key === "backup:last-ok"), false, "a failed run stamped itself as fresh");
});

test("the dump carries the loop's KV pins, by allowlist and never by prefix sweep", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR, {
    improve_mode: "subscription",
    "improve:budget": '{"actions_minutes_month":300,"model_usd_month":50}',
    "improve:anchor:capsid": "sha256-of-the-anchor-block",
    "improve:paused:foxing": "paused by hand",
    // A CACHED GITHUB TOKEN. It lives in the same namespace as the pins and must
    // never reach a dump: the dump leaves the account, and an installation token
    // is a credential.
    "gh:token:DrDustinEdwards": "ghs-not-a-real-token",
  });
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const raw = r2.objects.get(`${result.json_prefix}_kv.json`);
  assert.ok(raw, "the dump carries no KV pins; the loop's memory is not in the backup");
  const dumped = JSON.parse(raw as string) as { keys: Record<string, string | null> };
  assert.equal(dumped.keys.improve_mode, "subscription");
  assert.equal(dumped.keys["improve:anchor:capsid"], "sha256-of-the-anchor-block");
  assert.equal(dumped.keys["improve:paused:foxing"], "paused by hand");
  const leaked = Object.keys(dumped.keys).filter((k) => k.startsWith("gh:"));
  assert.deepEqual(leaked, [], "the KV dump swept a prefix and carried a cached credential out of the account");
});

test("the dump carries the holdout manifests, which are counts and never tests", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const raw = r2.objects.get(`${result.json_prefix}_holdout-manifests.json`);
  assert.ok(raw, "the dump carries no holdout manifests; the hidden suites' sizes exist in one place only");
  const dumped = JSON.parse(raw as string) as { manifests: Record<string, unknown> };
  assert.equal(dumped.manifests.capsid !== undefined, true, "capsid's manifest is missing from the dump");
});

// ---- audit findings F1-7, F1-8, F1-9 (2026-09-25) ------------------------------

test("an unreadable KV pin is recorded as unreadable, not as an unset null", async () => {
  // A restore that put back a null would clear a mode that existed.
  const { env, r2, kv } = makeEnv({ documents: DOCS }, MIRROR, { improve_mode: "subscription" });
  const get = kv.kv.get.bind(kv.kv);
  (kv.kv as unknown as { get: unknown }).get = async (key: string, ...rest: unknown[]) => {
    if (key === "improve_mode") throw new Error("KV get timed out");
    return (get as (k: string, ...r: unknown[]) => Promise<unknown>)(key, ...rest);
  };
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}_kv.json`) as string) as { keys: Record<string, unknown> };
  assert.deepEqual(dumped.keys.improve_mode, { unreadable: "KV get timed out" });
  // An unset key is still a plain null, so the two cases stay distinguishable.
  assert.equal(dumped.keys["improve:budget"], null);
});

// Seeds one run: every table object, plus the completion marker when `marked`.
// A partial run carries only documents.json, the prefix a run that threw leaves.
function seedRun(seed: Record<string, string>, id: string, shape: "marked" | "legacy" | "partial") {
  const tables = shape === "partial" ? ["documents"] : [...TABLES];
  for (const table of tables) seed[`backups/json/${id}/${table}.json`] = "{}";
  if (shape === "marked") seed[`backups/json/${id}/_complete.json`] = "{}";
}

function survivingRuns(r2: { objects: Map<string, string> }, ids: string[]): string[] {
  return ids.filter((id) => [...r2.objects.keys()].some((k) => k.startsWith(`backups/json/${id}/`)));
}

const day = (month: number, d: number) => `2020-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}T00-00-00-000Z`;

test("partial and refused runs take no slot in the 14-run floor", async () => {
  // 20 complete, marked runs, then 14 newer runs that never finished. All are past
  // the 90-day cutoff. Counting the partial runs, the floor would be 13 of them plus
  // today's run, and every complete dump would age out.
  const seed: Record<string, string> = { ...MIRROR };
  const marked = Array.from({ length: 20 }, (_, i) => day(1, i + 1));
  const partial = Array.from({ length: 14 }, (_, i) => day(2, i + 1));
  for (const id of marked) seedRun(seed, id, "marked");
  for (const id of partial) seedRun(seed, id, "partial");
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.deepEqual(survivingRuns(r2, marked), marked.slice(7), "the floor did not keep the 13 newest complete runs");
  assert.deepEqual(survivingRuns(r2, partial), [], "an aged partial run survived by holding a floor slot");
  assert.ok(r2.objects.has(`${result.json_prefix}_complete.json`), "today's run was not marked");
});

test("MIGRATION: runs written before the marker existed keep the floor they had", async () => {
  // The first run after deploy sees only unmarked runs plus its own marked one. They
  // sort before the oldest marked run, so they count exactly as the old rule counted
  // them, and the prune is the one the old rule made: the 7 oldest of 20.
  const seed: Record<string, string> = { ...MIRROR };
  const legacy = Array.from({ length: 20 }, (_, i) => day(1, i + 1));
  for (const id of legacy) seedRun(seed, id, "legacy");
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.json_backups_pruned, 7);
  assert.deepEqual(survivingRuns(r2, legacy), legacy.slice(7));
});

test("MIGRATION: legacy runs count, unmarked runs after the first marked one do not", async () => {
  // Ten legacy runs, then five marked runs from after the deploy, then five partial
  // runs. The floor is today's run, the five marked runs and the eight newest legacy
  // runs. The partial runs are aged and hold no slot, so they go.
  const seed: Record<string, string> = { ...MIRROR };
  const legacy = Array.from({ length: 10 }, (_, i) => day(1, i + 1));
  const marked = Array.from({ length: 5 }, (_, i) => day(1, i + 11));
  const partial = Array.from({ length: 5 }, (_, i) => day(1, i + 16));
  for (const id of legacy) seedRun(seed, id, "legacy");
  for (const id of marked) seedRun(seed, id, "marked");
  for (const id of partial) seedRun(seed, id, "partial");
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.deepEqual(survivingRuns(r2, marked), marked);
  assert.deepEqual(survivingRuns(r2, legacy), legacy.slice(2));
  assert.deepEqual(survivingRuns(r2, partial), []);
  assert.equal(result.json_backups_pruned, 7);
  assert.equal(result.json_backups_kept, 14);
});

test("a run whose lease was taken over does not release the new holder's lease", async () => {
  // The first run outlived its TTL and a second run took the key. The first run's
  // finally must leave the second run's lease in place.
  const r2 = fakeR2(MIRROR);
  const kv = fakeKv({});
  const d1 = fakeD1({ documents: DOCS });
  const batch = d1.db.batch.bind(d1.db);
  let first = true;
  (d1.db as unknown as { batch: typeof batch }).batch = (async (statements: Parameters<typeof batch>[0]) => {
    if (first) {
      first = false;
      kv.store.set("backup:lease", "2026-09-25T10:00:00.000Z another-run");
    }
    return batch(statements);
  }) as typeof batch;
  const env = fakeEnv({ DB: d1.db, MEDIA: r2.bucket, APP_KV: kv.kv });
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, true);

  assert.equal(kv.store.get("backup:lease"), "2026-09-25T10:00:00.000Z another-run", "the run deleted a lease it did not hold");
  assert.equal(kv.deleted.includes("backup:lease"), false);
  assert.ok(logged.some((line) => line.includes("BACKUP_LEASE_LOST")), logged.join("\n"));
  // The TTL sits above the 15-minute wall limit on a cron invocation.
  const lease = kv.puts.find((p) => p.key === "backup:lease");
  assert.ok((lease?.ttl ?? 0) > 900, `lease ttl ${lease?.ttl} does not cover a run past the cron wall limit`);
});
