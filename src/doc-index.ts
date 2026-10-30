import type { Env } from "./env";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { SEARCH_ROWS } from "./limits";
import type { SearchFilter, SearchRow } from "./doc-reads";

// The meaning index: every document, copied into a Cloudflare AI Search instance on
// built-in storage so search can match by meaning as well as by keyword
// (capsid/research/design-hybrid-search.md, step 1). D1 stays the source of truth.
// The index is derived from it and can be rebuilt from nothing.
//
// It is fed by the five-minute tick, not by the write paths: every writer of
// `documents` (documentUpsert, pathMutation, restore, docStatements) sets
// updated_at, so one watermark over (updated_at, id) catches them all without a hook
// in each. A move or delete leaves an index item behind; the daily reconcile removes
// it, and search re-checks every hit against D1 in any case, so a stale item is never
// served.
//
// Unbound (tests, local dev, a deploy without the binding), it does nothing and says so.

export const INDEX_INSTANCE = "capsid-docs";
// Documents sent per tick. 1,788 documents on 2026-10-15 backfill in about 90 minutes.
export const INDEX_BATCH = 100;
// Index items deleted per reconcile, so a mistake removes a bounded number.
const RECONCILE_DELETE_MAX = 200;
// AI Search lists at most 50 items a page.
const LIST_PAGE = 50;

// v2: the first live runs (2026-10-15) moved v1 past documents the index refused, so
// the backfill starts again. Uploads are upserts, so re-sending a document is harmless.
export const CURSOR_KEY = "doc-index:cursor:v2";
const READY_KEY = "doc-index:instance";
const RECONCILED_KEY = "doc-index:reconciled";

// Five fields, AI Search's limit per instance. A filter reads the first 64 bytes of a
// string, and namespace names are far shorter.
const INDEX_METADATA = [
  { field_name: "namespace", data_type: "text" },
  { field_name: "type", data_type: "text" },
  { field_name: "status", data_type: "text" },
  { field_name: "doc_id", data_type: "number" },
  { field_name: "canon", data_type: "boolean" },
] as const;

interface IndexRow {
  id: number;
  namespace: string;
  path: string;
  title: string | null;
  body: string | null;
  type: string | null;
  status: string | null;
  updated_at: string;
}

interface Cursor {
  updated_at: string;
  id: number;
}

// The current canon: the documents a ruling or convention lives in. Search boosts
// these over a session log that quotes an old ruling (design section 3.3).
export function isCanon(namespace: string, path: string): boolean {
  if (path === "core.md") return true;
  if (namespace !== "capsid") return false;
  return (
    /^conventions[^/]*\.md$/.test(path) ||
    path === "archive/decisions-vol-4.md" ||
    path === "archive/decisions-vol-8.md" ||
    path.startsWith("rulings/")
  );
}

// The item key. AI Search reads the type from the extension, so a path without .md
// gets one; the key is never read back into a path (doc_id is).
export function indexKey(namespace: string, path: string): string {
  return `${namespace}/${path}${path.endsWith(".md") ? "" : ".md"}`;
}

function indexContent(row: IndexRow): string {
  return `# ${row.title ?? row.path}\n\n${row.body ?? ""}`;
}

// Every value is sent as a string, as R2 custom metadata is: the live index refused
// a number and a boolean as invalid_metadata_format (2026-10-15). The instance's schema
// types them, so doc_id still filters as a number and canon as a boolean.
function indexMetadata(row: IndexRow): Record<string, string> {
  return {
    namespace: row.namespace,
    type: row.type ?? "note",
    status: row.status ?? "published",
    doc_id: String(row.id),
    canon: String(isCanon(row.namespace, row.path)),
  };
}

export interface IndexReport {
  ran: boolean;
  note: string;
  sent: number;
  failed: number;
  deleted: number;
}

const idle = (note: string): IndexReport => ({ ran: false, note, sent: 0, failed: 0, deleted: 0 });

async function ensureInstance(env: Env, ns: AiSearchNamespace): Promise<AiSearchInstance> {
  const instance = ns.get(INDEX_INSTANCE);
  if ((await env.APP_KV.get(READY_KEY)) === "ready") return instance;
  try {
    await instance.info();
  } catch {
    await ns.create({
      id: INDEX_INSTANCE,
      index_method: { vector: true, keyword: true },
      fusion_method: "rrf",
      custom_metadata: INDEX_METADATA.map((m) => ({ ...m })),
    });
    logEvent("DOC_INDEX_CREATED", { message: `DOC_INDEX_CREATED ${INDEX_INSTANCE}` });
  }
  await env.APP_KV.put(READY_KEY, "ready");
  return instance;
}

async function readCursor(env: Env): Promise<Cursor> {
  const raw = await env.APP_KV.get(CURSOR_KEY);
  if (!raw) return { updated_at: "", id: 0 };
  const parsed = JSON.parse(raw) as Partial<Cursor>;
  return { updated_at: String(parsed.updated_at ?? ""), id: Number(parsed.id ?? 0) };
}

// Documents changed since the cursor, oldest first. updated_at has one-second
// resolution, so the id breaks ties and two writes in one second are both sent.
async function changedSince(db: D1Database, cursor: Cursor, limit: number): Promise<IndexRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, namespace, path, title, body, type, status, updated_at FROM documents
       WHERE (updated_at, id) > (?1, ?2)
       ORDER BY updated_at, id LIMIT ?3`
    )
    .bind(cursor.updated_at, cursor.id, limit)
    .all<IndexRow>();
  return results;
}

// One document to the index. A refusal is logged and reported, never thrown, so one
// document AI Search will not take cannot stop the rest.
// Returns null when sent, or the refusal's message.
async function upload(instance: AiSearchInstance, row: IndexRow): Promise<string | null> {
  try {
    await instance.items.upload(indexKey(row.namespace, row.path), indexContent(row), { metadata: indexMetadata(row) });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("DOC_INDEX_UPLOAD_FAILED", { message: `DOC_INDEX_UPLOAD_FAILED ${row.namespace}/${row.path}: ${message}` }, { level: "error" });
    return message;
  }
}

/** Send what changed since the last tick. The cursor moves past every row tried, sent
 *  or not: one document AI Search refuses must not hold back the rest. A refusal is
 *  logged and counted, and the run is recorded as refused so it shows on Health. When
 *  every row is refused the fault is the index's, not a document's, so the cursor stays
 *  and the same rows are tried next tick. */
async function sendChanged(env: Env, instance: AiSearchInstance): Promise<{ tried: number; sent: number; failed: number; refusal: string | null }> {
  const rows = await changedSince(env.DB, await readCursor(env), INDEX_BATCH);
  let sent = 0;
  let failed = 0;
  let refusal: string | null = null;
  for (const row of rows) {
    const refused = await upload(instance, row);
    if (refused === null) sent++;
    else {
      failed++;
      refusal ??= refused;
    }
  }
  const last = rows.at(-1);
  if (last && sent > 0) await env.APP_KV.put(CURSOR_KEY, JSON.stringify({ updated_at: last.updated_at, id: last.id }));
  return { tried: rows.length, sent, failed, refusal };
}

/** Once a UTC day: remove index items whose document is gone or has moved, and
 *  re-send documents the index lacks (an upload that failed). Each side is bounded;
 *  the rest go on the next day's pass. */
async function reconcile(env: Env, instance: AiSearchInstance): Promise<{ deleted: number; resent: number; failed: number }> {
  const { results } = await env.DB.prepare("SELECT id, namespace, path FROM documents").all<{ id: number; namespace: string; path: string }>();
  const live = new Map(results.map((r) => [r.id, indexKey(r.namespace, r.path)]));
  const present = new Set<string>();
  const stale: string[] = [];
  for (let page = 1; ; page++) {
    const listed = await instance.items.list({ page, per_page: LIST_PAGE });
    for (const item of listed.result) {
      if (live.get(Number(item.metadata?.doc_id)) === item.key) present.add(item.key);
      else stale.push(item.id);
    }
    if (listed.result.length < LIST_PAGE) break;
  }
  let deleted = 0;
  for (const id of stale.slice(0, RECONCILE_DELETE_MAX)) {
    await instance.items.delete(id);
    deleted++;
  }
  const missing = [...live].filter(([, key]) => !present.has(key)).map(([id]) => id).slice(0, INDEX_BATCH);
  let resent = 0;
  let failed = 0;
  for (const id of missing) {
    const row = await env.DB.prepare(`SELECT id, namespace, path, title, body, type, status, updated_at FROM documents WHERE id = ?1`).bind(id).first<IndexRow>();
    if (!row) continue;
    if ((await upload(instance, row)) === null) resent++;
    else failed++;
  }
  return { deleted, resent, failed };
}

export async function docIndexTick(env: Env, now: Date): Promise<IndexReport> {
  const ns = env.AI_SEARCH;
  if (!ns) return idle("AI_SEARCH is not bound");
  const instance = await ensureInstance(env, ns);
  const { tried, sent, failed, refusal } = await sendChanged(env, instance);
  const today = now.toISOString().slice(0, 10);
  let deleted = 0;
  let resent = 0;
  let refused = 0;
  // Not until the backfill is done (before then every document is "missing"), and not
  // while the index refuses everything.
  if (tried < INDEX_BATCH && (sent > 0 || failed === 0) && (await env.APP_KV.get(RECONCILED_KEY)) !== today) {
    ({ deleted, resent, failed: refused } = await reconcile(env, instance));
    await env.APP_KV.put(RECONCILED_KEY, today);
  }
  const allFailed = failed + refused;
  if (sent === 0 && allFailed === 0 && deleted === 0 && resent === 0) return idle("nothing changed");
  return {
    ran: true,
    note: `sent ${sent}, failed ${failed}${refusal ? ` (first refusal: ${refusal})` : ""}; reconcile removed ${deleted} stale item(s), re-sent ${resent}, failed ${refused}`,
    sent: sent + resent,
    failed: allFailed,
    deleted,
  };
}

// Hybrid search (step 2 of the design): meaning plus keyword, through the index. The
// index decides only the order. Every hit is read back from D1 with the caller's
// filters, so a document the caller may not see, or one deleted or moved since it was
// indexed, is never returned. Anything that keeps the index from answering returns a
// reason instead of rows, and the caller falls back to FTS5.
//
// Queries are counted per month in KV. The account's free 1,000 a month is shared with
// the site's Ask, and a paid hybrid query costs $0.00075, so the cap holds the worst case
// near $4 a month (Dustin's $5 cap, decision D1 of the design).
export const HYBRID_MONTHLY_CAP = 5000;
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const SNIPPET_CHARS = 240;
// Closed tasks and superseded rulings stay searchable on request but are hidden by
// default, so an old answer does not sit beside the current one (design 3.2).
const RETIRED = ["closed", "superseded"];

const countKey = (now: Date) => `doc-index:queries:${now.toISOString().slice(0, 7)}`;

/** This month's hybrid queries, for /health (design 3.5). */
export async function aiSearchUsage(env: Env, now: Date = new Date()): Promise<{ month: string; hybrid: number; cap: number }> {
  return { month: now.toISOString().slice(0, 7), hybrid: Number((await env.APP_KV.get(countKey(now))) ?? 0), cap: HYBRID_MONTHLY_CAP };
}

type Match = "keyword" | "meaning" | "both";
export type HybridRow = SearchRow & { match: Match };

function matchOf(chunk: AiSearchSearchResponse["chunks"][number]): Match {
  const d = chunk.scoring_details;
  const keyword = d?.keyword_rank !== undefined || (d?.keyword_score ?? 0) > 0;
  const meaning = d?.vector_rank !== undefined || (d?.vector_score ?? 0) > 0;
  return keyword && meaning ? "both" : keyword ? "keyword" : "meaning";
}

const joinMatch = (a: Match, b: Match): Match => (a === b ? a : "both");

export async function hybridSearch(
  env: Env,
  query: string,
  filter: SearchFilter & { includeRetired?: boolean },
  now: Date = new Date()
): Promise<HybridRow[] | string> {
  const ns = env.AI_SEARCH;
  if (!ns) return "AI_SEARCH is not bound";
  if ((await env.APP_KV.get(READY_KEY)) !== "ready") return "the search index is not built yet";
  const key = countKey(now);
  const used = Number((await env.APP_KV.get(key)) ?? 0);
  if (used >= HYBRID_MONTHLY_CAP) return `this month's ${HYBRID_MONTHLY_CAP} hybrid queries are used`;
  await env.APP_KV.put(key, String(used + 1), { expirationTtl: 40 * 86_400 });

  const filters: Record<string, { $eq: string } | { $nin: string[] }> = {};
  if (filter.namespace) filters.namespace = { $eq: filter.namespace };
  if (filter.type) filters.type = { $eq: filter.type };
  if (!filter.includeRetired) filters.status = { $nin: RETIRED };
  let chunks: AiSearchSearchResponse["chunks"];
  try {
    ({ chunks } = await ns.get(INDEX_INSTANCE).search({
      query,
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          max_num_results: 50,
          return_on_failure: false,
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
          // The current canon ranks above a session log that quotes an old ruling (3.3).
          boost_by: [{ field: "canon", direction: "desc" }],
        },
        // A cross-encoder reorders the fused candidates by how well each answers the
        // query, the step the usual hybrid pipeline adds after fusion. Threshold 0: it
        // reorders, it never drops a candidate the fusion found.
        reranking: { enabled: true, model: RERANK_MODEL, match_threshold: 0 },
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("DOC_INDEX_SEARCH_FAILED", { message: `DOC_INDEX_SEARCH_FAILED ${message}` }, { level: "warn" });
    return `the search index refused the query: ${message}`;
  }

  // Best chunk first, so a document's first chunk sets its rank and its snippet; every
  // chunk of it adds to how it matched.
  const ranked = new Map<number, { snippet: string; match: Match }>();
  for (const chunk of chunks) {
    const id = Number(chunk.item.metadata?.doc_id);
    if (!Number.isInteger(id)) continue;
    const seen = ranked.get(id);
    if (seen) seen.match = joinMatch(seen.match, matchOf(chunk));
    else ranked.set(id, { snippet: chunk.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS), match: matchOf(chunk) });
  }
  if (ranked.size === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, namespace, path, title, type, status, updated_at FROM documents
     WHERE id IN (SELECT value FROM json_each(?1))
       AND (?2 IS NULL OR namespace = ?2)
       AND (?3 IS NULL OR type = ?3)
       AND (?4 IS NULL OR path IN (SELECT value FROM json_each(?4)))
       AND (?5 = 1 OR status IS NULL OR status NOT IN (SELECT value FROM json_each(?6)))`
  )
    .bind(JSON.stringify([...ranked.keys()]), filter.namespace, filter.type, filter.allowed, filter.includeRetired ? 1 : 0, JSON.stringify(RETIRED))
    .all<Omit<SearchRow, "snippet">>();
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows: HybridRow[] = [];
  for (const [id, hit] of ranked) {
    const row = byId.get(id);
    if (row) rows.push({ ...row, ...hit });
    if (rows.length > SEARCH_ROWS) break;
  }
  return rows;
}
