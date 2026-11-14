import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  HYBRID_MONTHLY_CAP,
  aiSearchUsage,
  INDEX_INSTANCE,
  INDEX_QUERY,
  docIndexTick,
  hybridSearch,
} from "../src/doc-index.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// AI Search reads the meaning index's rows from D1 itself, so these run the real
// migrations (the FTS triggers included) in Node's SQLite, and AI Search is an in-memory
// fake that records what it was asked.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const DAY1 = new Date("2026-10-15T12:00:00Z");

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
  for (const name of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return { raw, db: d1(raw) };
}

function put(
  raw: DatabaseSync,
  namespace: string,
  path: string,
  body: string,
  updated_at = "2026-10-15 10:00:00",
): number {
  raw
    .prepare(
      "INSERT INTO documents (namespace, path, title, body, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(namespace, path, path, body, updated_at);
  return Number(
    (
      raw
        .prepare("SELECT id FROM documents WHERE namespace = ? AND path = ?")
        .get(namespace, path) as { id: number }
    ).id,
  );
}

function fakeSearch(
  opts: {
    running?: boolean;
    search?: (request: AiSearchSearchRequest) => AiSearchSearchResponse["chunks"];
  } = {},
) {
  const updates: unknown[] = [];
  const jobs: string[] = [];
  const instance = {
    search: async (request: AiSearchSearchRequest) => {
      if (!opts.search) throw new Error("no search fake");
      return { search_query: request.query ?? "", chunks: opts.search(request) };
    },
    update: async (config: unknown) => {
      updates.push(config);
      return { id: INDEX_INSTANCE };
    },
    jobs: {
      // A sync already running answers a new request with itself (seen live 2026-11-14).
      create: async () => {
        const at = opts.running ? new Date(Date.now() - 60_000) : new Date(Date.now() + 1000);
        jobs.push(`job-${jobs.length + 1}`);
        return {
          id: jobs.at(-1),
          source: "user",
          started_at: at.toISOString().slice(0, 19).replace("T", " "),
        };
      },
    },
  };
  const ns = {
    get: (name: string) => {
      assert.equal(name, INDEX_INSTANCE);
      return instance;
    },
  } as unknown as AiSearchNamespace;
  return { ns, updates, jobs };
}

test("unbound, the tick does nothing and says so", async () => {
  const { db } = fresh();
  const report = await docIndexTick(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv }));
  assert.deepEqual([report.ran, report.note], [false, "AI_SEARCH is not bound"]);
});

test("the tick sends the query once and starts a sync only when the store changed", async () => {
  const { raw, db } = fresh();
  put(raw, "sample", "a.md", "one");
  const search = fakeSearch();
  const kv = fakeKv({});
  const env = fakeEnv({ DB: db, APP_KV: kv.kv, AI_SEARCH: search.ns });
  const first = await docIndexTick(env);
  assert.deepEqual(search.updates, [
    { source_params: { d1: { query: INDEX_QUERY, template: "content_only" } } },
  ]);
  assert.deepEqual([first.ran, first.failed, search.jobs.length], [true, 0, 1]);
  assert.equal((await docIndexTick(env)).note, "nothing changed");
  raw.prepare("DELETE FROM documents WHERE path = 'a.md'").run();
  assert.equal((await docIndexTick(env)).ran, true, "a delete starts a sync");
  assert.deepEqual([search.updates.length, search.jobs.length], [1, 2]);
});

test("PLANT: a sync already running is not taken for one that saw the change", async () => {
  const { raw, db } = fresh();
  put(raw, "sample", "a.md", "one");
  const search = fakeSearch({ running: true });
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, AI_SEARCH: search.ns });
  assert.match((await docIndexTick(env)).note, /already running/);
  assert.match((await docIndexTick(env)).note, /already running/, "the next tick asks again");
  assert.equal(search.jobs.length, 2);
});

test("the index query runs on the real schema, marks the canon and keeps AI Search's rules", () => {
  const { raw } = fresh();
  const paths: Array<[string, string, number]> = [
    ["capsid", "conventions.md", 1],
    ["capsid", "conventions-cloud.md", 1],
    ["capsid", "rulings/testing-2026-10-04.md", 1],
    ["capsid", "archive/decisions-vol-8.md", 1],
    ["sample", "core.md", 1],
    ["capsid", "decisions.md", 0],
    ["capsid", "archive/decisions-vol-1.md", 0],
    ["capsid", "notes/conventions.md", 0],
    ["sample", "rulings/x.md", 0],
    ["capsid", "handoffs/session.md", 0],
  ];
  for (const [ns, path] of paths) put(raw, ns, path, "body");
  const rows = raw.prepare(INDEX_QUERY).all() as Array<Record<string, unknown>>;
  const canon = new Map(rows.map((r) => [r.id, r.meta_canon]));
  for (const [ns, path, want] of paths) {
    const id = (
      raw.prepare("SELECT id FROM documents WHERE namespace = ? AND path = ?").get(ns, path) as {
        id: number;
      }
    ).id;
    assert.equal(canon.get(id), want, `${ns}/${path}`);
  }
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
    "content",
    "id",
    "meta_canon",
    "meta_namespace",
    "meta_status",
    "meta_type",
    "title",
  ]);
  // https://developers.cloudflare.com/ai-search/configuration/data-source/d1/#query-requirements
  assert.doesNotMatch(INDEX_QUERY, /;|--|\/\*|\?|\bORDER BY\b|\bLIMIT\b|\breplace\(/i);
  assert.ok(INDEX_QUERY.length <= 10_000);
});

// Hybrid search

const chunk = (
  doc_id: number,
  text: string,
  score: number,
  ranks: { keyword_rank?: number; vector_rank?: number } = { vector_rank: 1 },
) => ({
  id: `c${doc_id}-${score}`,
  type: "text",
  score,
  text,
  item: { key: `${doc_id}.md`, metadata: { row_id: String(doc_id) } },
  scoring_details: ranks,
});
const READY = { "doc-index:instance": INDEX_QUERY };

test("hybrid search keeps the index's order and reads every hit back from D1 with the caller's filters", async () => {
  const { raw, db } = fresh();
  const a = put(raw, "sample", "a.md", "alpha body");
  const b = put(raw, "sample", "b.md", "beta body");
  const other = put(raw, "elsewhere", "c.md", "gamma body");
  const gone = put(raw, "sample", "gone.md", "deleted since indexing");
  raw.prepare("DELETE FROM documents WHERE id = ?").run(gone);
  const requests: AiSearchSearchRequest[] = [];
  const search = fakeSearch({
    search: (request) => {
      requests.push(request);
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

  const rows = await hybridSearch(
    env,
    "what about beta",
    { namespace: "sample", type: null, allowed: null },
    DAY1,
  );
  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((r) => r.path),
    ["b.md", "a.md"],
    "the deleted document and the other namespace's are dropped, the order kept",
  );
  assert.equal(rows[0].snippet, "beta best chunk", "the best chunk is the snippet");
  assert.deepEqual(
    rows.map((r) => r.match),
    ["both", "keyword"],
    "a document's chunks add up to how it matched",
  );
  const seen = requests.at(-1);
  const retrieval = seen?.ai_search_options?.retrieval;
  assert.equal(retrieval?.retrieval_type, "hybrid");
  assert.equal(
    retrieval?.return_on_failure,
    false,
    "a failure throws, so the caller falls back instead of seeing nothing",
  );
  assert.deepEqual(retrieval?.filters, {
    namespace: { $eq: "sample" },
    status: { $nin: ["closed", "superseded"] },
  });
  assert.deepEqual(retrieval?.boost_by, [{ field: "canon", direction: "desc" }]);
  assert.deepEqual(
    seen?.ai_search_options?.reranking,
    { enabled: true, model: "@cf/baai/bge-reranker-base", match_threshold: 0 },
    "reranking reorders and drops nothing",
  );
  assert.equal(await kv.kv.get("doc-index:queries:2026-10"), "1", "the query is counted");
  assert.deepEqual(
    await aiSearchUsage(env, DAY1),
    { month: "2026-10", hybrid: 1, cap: HYBRID_MONTHLY_CAP },
    "and reported for /health",
  );

  const limited = await hybridSearch(
    env,
    "what about beta",
    { namespace: null, type: null, allowed: JSON.stringify(["a.md"]) },
    DAY1,
  );
  assert.deepEqual(
    Array.isArray(limited) && limited.map((r) => r.path),
    ["a.md"],
    "a path limit holds even when the index returns more",
  );
});

test("hybrid search says why instead of answering when the index cannot, so the caller falls back", async () => {
  const { db } = fresh();
  const failing = fakeSearch({
    search: () => {
      throw new Error("index unavailable");
    },
  });
  const filter = { namespace: null, type: null, allowed: null };
  assert.equal(
    await hybridSearch(
      fakeEnv({ DB: db, APP_KV: fakeKv({ seed: { ...READY } }).kv }),
      "q",
      filter,
      DAY1,
    ),
    "AI_SEARCH is not bound",
  );
  assert.equal(
    await hybridSearch(
      fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, AI_SEARCH: failing.ns }),
      "q",
      filter,
      DAY1,
    ),
    "the search index is not built yet",
  );
  const capped = fakeKv({
    seed: { ...READY, "doc-index:queries:2026-10": String(HYBRID_MONTHLY_CAP) },
  });
  assert.match(
    String(
      await hybridSearch(
        fakeEnv({ DB: db, APP_KV: capped.kv, AI_SEARCH: failing.ns }),
        "q",
        filter,
        DAY1,
      ),
    ),
    /hybrid queries are used/,
  );
  assert.match(
    String(
      await hybridSearch(
        fakeEnv({ DB: db, APP_KV: fakeKv({ seed: { ...READY } }).kv, AI_SEARCH: failing.ns }),
        "q",
        filter,
        DAY1,
      ),
    ),
    /^the search index did not answer$/,
  );
});

test("retired documents are hidden unless asked for, in the index's filter and again in D1", async () => {
  const { raw, db } = fresh();
  const live = put(raw, "sample", "live.md", "current");
  const old = put(raw, "sample", "old.md", "replaced");
  raw.prepare("UPDATE documents SET status = 'superseded' WHERE id = ?").run(old);
  const requests: AiSearchSearchRequest[] = [];
  // The fake ignores the filter, as a stale index entry would: the D1 read must still hold.
  const search = fakeSearch({
    search: (request) => {
      requests.push(request);
      return [chunk(old, "old", 0.9), chunk(live, "live", 0.8)];
    },
  });
  const env = fakeEnv({ DB: db, APP_KV: fakeKv({ seed: { ...READY } }).kv, AI_SEARCH: search.ns });
  const filter = { namespace: null, type: null, allowed: null };
  const hidden = await hybridSearch(env, "q", filter, DAY1);
  assert.deepEqual(Array.isArray(hidden) && hidden.map((r) => r.path), ["live.md"]);
  const shown = await hybridSearch(env, "q", { ...filter, includeRetired: true }, DAY1);
  assert.deepEqual(Array.isArray(shown) && shown.map((r) => r.path), ["old.md", "live.md"]);
  assert.equal(
    requests.at(-1)?.ai_search_options?.retrieval?.filters,
    undefined,
    "include_retired drops the status filter",
  );
});
