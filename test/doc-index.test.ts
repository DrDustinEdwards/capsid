import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CURSOR_KEY, HYBRID_MONTHLY_CAP, aiSearchUsage, INDEX_BATCH, INDEX_INSTANCE, docIndexTick, hybridSearch, indexKey, isCanon } from "../src/doc-index.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// The meaning index is fed from D1 by a watermark, so these run the real migrations
// (the FTS triggers included) in Node's SQLite, and AI Search is an in-memory fake that
// records what it was sent.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const DAY1 = new Date("2026-10-15T12:00:00Z");
const DAY2 = new Date("2026-10-16T12:00:00Z");

function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const s = db.prepare(sql);
    const args = params as Array<string | number | null>;
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (s.get(...args) as Record<string, unknown> | undefined) ?? null,
      all: async () => ({ results: s.all(...args).map((r) => ({ ...r })) }),
      run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }),
    };
  };
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function fresh(): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return { raw, db: d1(raw) };
}

function put(raw: DatabaseSync, namespace: string, path: string, body: string, updated_at = "2026-10-15 10:00:00"): number {
  raw.prepare("INSERT INTO documents (namespace, path, title, body, updated_at) VALUES (?, ?, ?, ?, ?)").run(namespace, path, path, body, updated_at);
  return Number((raw.prepare("SELECT id FROM documents WHERE namespace = ? AND path = ?").get(namespace, path) as { id: number }).id);
}

interface FakeItem {
  id: string;
  key: string;
  content: string;
  metadata: Record<string, unknown>;
}

function fakeSearch(opts: { exists?: boolean; refuse?: (key: string) => boolean; search?: (request: AiSearchSearchRequest) => AiSearchSearchResponse["chunks"] } = {}) {
  const items = new Map<string, FakeItem>();
  const created: unknown[] = [];
  let next = 1;
  let exists = opts.exists ?? false;
  const instance = {
    search: async (request: AiSearchSearchRequest) => {
      if (!opts.search) throw new Error("no search fake");
      return { search_query: request.query ?? "", chunks: opts.search(request) };
    },
    info: async () => {
      if (!exists) throw new Error("AiSearchNotFoundError");
      return { id: INDEX_INSTANCE };
    },
    items: {
      upload: async (key: string, content: string, o?: { metadata?: Record<string, unknown> }) => {
        if (opts.refuse?.(key)) throw new Error("refused");
        // The live index refused a number and a boolean (2026-10-15).
        if (Object.values(o?.metadata ?? {}).some((v) => typeof v !== "string")) throw new Error("invalid_metadata_format");
        const prior = [...items.values()].find((i) => i.key === key);
        const id = prior?.id ?? `item-${next++}`;
        items.set(id, { id, key, content, metadata: o?.metadata ?? {} });
        return { id, key, status: "queued" };
      },
      list: async (p: { page?: number; per_page?: number } = {}) => {
        // The real binding's limit; it refused 100 in production on 2026-10-15.
        if ((p.per_page ?? 20) > 50) throw new Error("Too big: expected number to be <=50");
        const all = [...items.values()];
        const size = p.per_page ?? 20;
        const start = ((p.page ?? 1) - 1) * size;
        return { result: all.slice(start, start + size).map((i) => ({ id: i.id, key: i.key, status: "completed", metadata: i.metadata })) };
      },
      delete: async (id: string) => {
        items.delete(id);
      },
    },
  };
  const ns = {
    get: (name: string) => {
      assert.equal(name, INDEX_INSTANCE);
      return instance;
    },
    create: async (config: unknown) => {
      created.push(config);
      exists = true;
      return instance;
    },
  } as unknown as AiSearchNamespace;
  return { ns, items, created, keys: () => [...items.values()].map((i) => i.key).sort() };
}

test("unbound, the tick does nothing and says so", async () => {
  const { db } = fresh();
  const report = await docIndexTick(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv }), DAY1);
  assert.deepEqual([report.ran, report.note], [false, "AI_SEARCH is not bound"]);
});

test("first tick creates a hybrid instance with the five metadata fields and sends every document", async () => {
  const { raw, db } = fresh();
  put(raw, "capsid", "rulings/testing.md", "Tested once where code lives.");
  put(raw, "sample", "notes/backup", "Nightly dump to R2.");
  const search = fakeSearch();
  const kv = fakeKv({});
  const report = await docIndexTick(fakeEnv({ DB: db, APP_KV: kv.kv, AI_SEARCH: search.ns }), DAY1);
  assert.equal(search.created.length, 1);
  const config = search.created[0] as { index_method: unknown; custom_metadata: Array<{ field_name: string }> };
  assert.deepEqual(config.index_method, { vector: true, keyword: true });
  assert.deepEqual(config.custom_metadata.map((m) => m.field_name), ["namespace", "type", "status", "doc_id", "canon"]);
  assert.deepEqual(search.keys(), ["capsid/rulings/testing.md", "sample/notes/backup.md"]);
  const ruling = [...search.items.values()].find((i) => i.key === "capsid/rulings/testing.md");
  assert.equal(ruling?.content, "# rulings/testing.md\n\nTested once where code lives.");
  assert.deepEqual(ruling?.metadata, { namespace: "capsid", type: "note", status: "published", doc_id: "1", canon: "true" });
  assert.equal(report.sent, 2);

  // Nothing changed: no upload, no run recorded, and an existing instance is not re-created.
  const again = await docIndexTick(fakeEnv({ DB: db, APP_KV: kv.kv, AI_SEARCH: search.ns }), DAY1);
  assert.deepEqual([again.ran, again.sent, search.created.length], [false, 0, 1]);
});

test("an edit is sent on the next tick, and two writes in the same second are both sent", async () => {
  const { raw, db } = fresh();
  put(raw, "sample", "a.md", "one");
  const search = fakeSearch({ exists: true });
  const kv = fakeKv({});
  const env = fakeEnv({ DB: db, APP_KV: kv.kv, AI_SEARCH: search.ns });
  await docIndexTick(env, DAY1);
  put(raw, "sample", "b.md", "two", "2026-10-15 11:00:00");
  put(raw, "sample", "c.md", "three", "2026-10-15 11:00:00");
  raw.prepare("UPDATE documents SET body = 'one, edited', updated_at = '2026-10-15 11:00:00' WHERE path = 'a.md'").run();
  const report = await docIndexTick(env, DAY1);
  assert.equal(report.sent, 3);
  assert.equal([...search.items.values()].find((i) => i.key === "sample/a.md")?.content, "# a.md\n\none, edited");
  assert.deepEqual(JSON.parse(kv.store.get(CURSOR_KEY) ?? "{}"), { updated_at: "2026-10-15 11:00:00", id: 3 });
});

test("a backfill larger than one batch goes a batch per tick", async () => {
  const { raw, db } = fresh();
  for (let i = 0; i < INDEX_BATCH + 5; i++) put(raw, "sample", `n/${i}.md`, `doc ${i}`);
  const search = fakeSearch({ exists: true });
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, AI_SEARCH: search.ns });
  assert.equal((await docIndexTick(env, DAY1)).sent, INDEX_BATCH);
  assert.equal((await docIndexTick(env, DAY1)).sent, 5);
  assert.equal(search.items.size, INDEX_BATCH + 5);
});

test("a refused upload is counted and does not hold back the rest; the next day's reconcile re-sends it", async () => {
  const { raw, db } = fresh();
  put(raw, "sample", "bad.md", "x");
  put(raw, "sample", "good.md", "y");
  let refuse = true;
  const search = fakeSearch({ exists: true, refuse: (key) => refuse && key === "sample/bad.md" });
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, AI_SEARCH: search.ns });
  const first = await docIndexTick(env, DAY1);
  // Refused twice: on the tick's send, and again by the same day's first reconcile.
  assert.deepEqual([first.ran, first.sent, first.failed], [true, 1, 2]);
  assert.deepEqual(search.keys(), ["sample/good.md"]);
  refuse = false;
  const next = await docIndexTick(env, DAY2);
  assert.deepEqual([next.sent, next.failed], [1, 0]);
  assert.deepEqual(search.keys(), ["sample/bad.md", "sample/good.md"]);
});

test("PLANT: the daily reconcile removes the items of a deleted and a moved document, and keeps the rest", async () => {
  const { raw, db } = fresh();
  put(raw, "sample", "keep.md", "k");
  put(raw, "sample", "gone.md", "g");
  const moved = put(raw, "sample", "old.md", "m");
  const search = fakeSearch({ exists: true });
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, AI_SEARCH: search.ns });
  await docIndexTick(env, DAY1);
  raw.prepare("DELETE FROM documents WHERE path = 'gone.md'").run();
  raw.prepare("UPDATE documents SET path = 'new.md', updated_at = '2026-10-16 01:00:00' WHERE id = ?").run(moved);
  // Same day: the move is sent, but the reconcile already ran, so the old items stay.
  await docIndexTick(env, DAY1);
  assert.deepEqual(search.keys(), ["sample/gone.md", "sample/keep.md", "sample/new.md", "sample/old.md"]);
  const report = await docIndexTick(env, DAY2);
  assert.equal(report.deleted, 2);
  assert.deepEqual(search.keys(), ["sample/keep.md", "sample/new.md"]);
});

test("canon is the conventions, decisions, rulings and every core.md; keys always end in .md", () => {
  assert.ok(isCanon("capsid", "conventions.md"));
  assert.ok(isCanon("capsid", "conventions-cloud.md"));
  assert.ok(isCanon("capsid", "rulings/testing-2026-10-04.md"));
  assert.ok(isCanon("capsid", "archive/decisions-vol-8.md"));
  assert.ok(!isCanon("capsid", "decisions.md"), "the old decisions log is gone");
  assert.ok(isCanon("sample", "core.md"));
  assert.ok(!isCanon("capsid", "archive/decisions-vol-1.md"), "a closed log volume is history");
  assert.ok(!isCanon("sample", "rulings/x.md"), "rulings are capsid's");
  assert.ok(!isCanon("capsid", "handoffs/session.md"));
  assert.equal(indexKey("sample", "jobs/job_1.md"), "sample/jobs/job_1.md");
  assert.equal(indexKey("sample", "notes/backup"), "sample/notes/backup.md");
});

// Hybrid search

const chunk = (doc_id: number, text: string, score: number, ranks: { keyword_rank?: number; vector_rank?: number } = { vector_rank: 1 }) => ({
  id: `c${doc_id}-${score}`,
  type: "text",
  score,
  text,
  item: { key: `k${doc_id}`, metadata: { doc_id: String(doc_id) } },
  scoring_details: ranks,
});
const READY = { "doc-index:instance": "ready" };

test("hybrid search keeps the index's order and reads every hit back from D1 with the caller's filters", async () => {
  const { raw, db } = fresh();
  const a = put(raw, "sample", "a.md", "alpha body");
  const b = put(raw, "sample", "b.md", "beta body");
  const other = put(raw, "elsewhere", "c.md", "gamma body");
  const gone = put(raw, "sample", "gone.md", "deleted since indexing");
  raw.prepare("DELETE FROM documents WHERE id = ?").run(gone);
  let seen: AiSearchSearchRequest | undefined;
  const search = fakeSearch({
    exists: true,
    search: (request) => {
      seen = request;
      return [
        chunk(b, "beta   best\nchunk", 0.9, { vector_rank: 1 }),
        chunk(gone, "stale", 0.8),
        chunk(other, "gamma", 0.7),
        chunk(a, "alpha", 0.6, { keyword_rank: 1 }),
        chunk(b, "beta second chunk", 0.5, { keyword_rank: 2 }),
      ];
    },
  });
  const kv = fakeKv({ seed: { ...READY } });
  const env = fakeEnv({ DB: db, APP_KV: kv.kv, AI_SEARCH: search.ns });

  const rows = await hybridSearch(env, "what about beta", { namespace: "sample", type: null, allowed: null }, DAY1);
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map((r) => r.path), ["b.md", "a.md"], "the deleted document and the other namespace's are dropped, the order kept");
  assert.equal(rows[0].snippet, "beta best chunk", "the best chunk is the snippet");
  assert.deepEqual(rows.map((r) => r.match), ["both", "keyword"], "a document's chunks add up to how it matched");
  const retrieval = seen?.ai_search_options?.retrieval;
  assert.equal(retrieval?.retrieval_type, "hybrid");
  assert.equal(retrieval?.return_on_failure, false, "a failure throws, so the caller falls back instead of seeing nothing");
  assert.deepEqual(retrieval?.filters, { namespace: { $eq: "sample" }, status: { $nin: ["closed", "superseded"] } });
  assert.deepEqual(retrieval?.boost_by, [{ field: "canon", direction: "desc" }]);
  assert.equal(await kv.kv.get("doc-index:queries:2026-10"), "1", "the query is counted");
  assert.deepEqual(await aiSearchUsage(env, DAY1), { month: "2026-10", hybrid: 1, cap: HYBRID_MONTHLY_CAP }, "and reported for /health");

  const limited = await hybridSearch(env, "what about beta", { namespace: null, type: null, allowed: JSON.stringify(["a.md"]) }, DAY1);
  assert.deepEqual(Array.isArray(limited) && limited.map((r) => r.path), ["a.md"], "a path limit holds even when the index returns more");
});

test("hybrid search says why instead of answering when the index cannot, so the caller falls back", async () => {
  const { db } = fresh();
  const failing = fakeSearch({
    exists: true,
    search: () => {
      throw new Error("index unavailable");
    },
  });
  const filter = { namespace: null, type: null, allowed: null };
  assert.equal(await hybridSearch(fakeEnv({ DB: db, APP_KV: fakeKv({ seed: { ...READY } }).kv }), "q", filter, DAY1), "AI_SEARCH is not bound");
  assert.equal(await hybridSearch(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, AI_SEARCH: failing.ns }), "q", filter, DAY1), "the search index is not built yet");
  const capped = fakeKv({ seed: { ...READY, "doc-index:queries:2026-10": String(HYBRID_MONTHLY_CAP) } });
  assert.match(String(await hybridSearch(fakeEnv({ DB: db, APP_KV: capped.kv, AI_SEARCH: failing.ns }), "q", filter, DAY1)), /hybrid queries are used/);
  assert.match(String(await hybridSearch(fakeEnv({ DB: db, APP_KV: fakeKv({ seed: { ...READY } }).kv, AI_SEARCH: failing.ns }), "q", filter, DAY1)), /refused the query: index unavailable/);
});

test("when the index refuses every document the cursor stays, reconcile waits, and the note names the refusal", async () => {
  const { raw, db } = fresh();
  put(raw, "sample", "a.md", "one");
  put(raw, "sample", "b.md", "two");
  const search = fakeSearch({ refuse: () => true });
  const kv = fakeKv({});
  const env = fakeEnv({ DB: db, APP_KV: kv.kv, AI_SEARCH: search.ns });
  const report = await docIndexTick(env, DAY1);
  assert.equal(report.sent, 0);
  assert.equal(report.failed, 2);
  assert.match(report.note, /first refusal: refused/);
  assert.equal(await kv.kv.get(CURSOR_KEY), null, "the cursor did not move past rows nothing accepted");
  assert.equal(await kv.kv.get("doc-index:reconciled"), null, "no reconcile while everything is refused");
});

test("retired documents are hidden unless asked for, in the index's filter and again in D1", async () => {
  const { raw, db } = fresh();
  const live = put(raw, "sample", "live.md", "current");
  const old = put(raw, "sample", "old.md", "replaced");
  raw.prepare("UPDATE documents SET status = 'superseded' WHERE id = ?").run(old);
  let seen: AiSearchSearchRequest | undefined;
  // The fake ignores the filter, as a stale index entry would: the D1 read must still hold.
  const search = fakeSearch({
    exists: true,
    search: (request) => {
      seen = request;
      return [chunk(old, "old", 0.9), chunk(live, "live", 0.8)];
    },
  });
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({ seed: { ...READY } }).kv, AI_SEARCH: search.ns });
  const filter = { namespace: null, type: null, allowed: null };
  const hidden = await hybridSearch(env, "q", filter, DAY1);
  assert.deepEqual(Array.isArray(hidden) && hidden.map((r) => r.path), ["live.md"]);
  const shown = await hybridSearch(env, "q", { ...filter, includeRetired: true }, DAY1);
  assert.deepEqual(Array.isArray(shown) && shown.map((r) => r.path), ["old.md", "live.md"]);
  assert.equal(seen?.ai_search_options?.retrieval?.filters, undefined, "include_retired drops the status filter");
});
