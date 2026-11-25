import type { Env } from "./env";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { SEARCH_ROWS } from "./limits";
import type { SearchFilter, SearchRow } from "./doc-reads";

// The meaning index: every document, in a Cloudflare AI Search instance whose data source is this
// Worker's own D1 database (AI Search D1 data source, beta:
// https://developers.cloudflare.com/ai-search/configuration/data-source/d1/), so search can match
// by meaning as well as keyword (capsid/research/design-hybrid-search.md, step 1).

export const INDEX_INSTANCE = "capsid-documents";

const SYNCED_KEY = "doc-index:synced";
const READY_KEY = "doc-index:instance";
const GATEWAY_KEY = "doc-index:gateway";
const SEARCH_TIMEOUT_MS = 8_000;

// meta_canon is the current canon (the documents a ruling or convention lives in), which search
// boosts over a session log quoting an old ruling (design 3.3). AI Search allows five meta_
// columns and puts each row's id on every chunk as `row_id`, so the id needs none.
export const INDEX_QUERY = `SELECT id, title, substr(body, 1, 63000) AS content,
  namespace AS meta_namespace, coalesce(type, 'note') AS meta_type,
  coalesce(status, 'published') AS meta_status,
  CASE WHEN path = 'core.md' OR (namespace = 'capsid' AND (
    (path GLOB 'conventions*.md' AND instr(path, '/') = 0)
    OR substr(path, 1, 8) = 'rulings/')) THEN 1 ELSE 0 END AS meta_canon
FROM documents`;

// Title and content only: the default labeled template also writes every meta_ column into the
// text, where it would be embedded and matched as if it were the document's.
const INDEX_TEMPLATE = "content_only";

export interface IndexReport {
  ran: boolean;
  note: string;
  failed: number;
}

const idle = (note: string): IndexReport => ({ ran: false, note, failed: 0 });

// A missing instance is refused, never silently re-created, because creating one needs the token
// the API call names.
async function ensureInstance(env: Env, ns: AiSearchNamespace): Promise<AiSearchInstance> {
  const instance = ns.get(INDEX_INSTANCE);
  if ((await env.APP_KV.get(READY_KEY)) === INDEX_QUERY) return instance;
  await instance.update({
    source_params: { d1: { query: INDEX_QUERY, template: INDEX_TEMPLATE } },
  });
  await env.APP_KV.put(READY_KEY, INDEX_QUERY);
  await env.APP_KV.delete(SYNCED_KEY);
  logEvent("DOC_INDEX_QUERY_SET", { message: `DOC_INDEX_QUERY_SET ${INDEX_INSTANCE}` });
  return instance;
}

// The reranker and the embedding model run inside AI Search, so a search call has no gateway of
// its own to name: the instance names it (`ai_gateway_id`), and every model call it makes then
// goes through that gateway's logs, rate limits and spend limits.
async function routeThroughGateway(env: Env, instance: AiSearchInstance): Promise<void> {
  const id = env.AI_GATEWAY_ID?.trim();
  if (!id || (await env.APP_KV.get(GATEWAY_KEY)) === id) return;
  try {
    await instance.update({ ai_gateway_id: id });
    await env.APP_KV.put(GATEWAY_KEY, id);
    logEvent("DOC_INDEX_GATEWAY_SET", {
      message: `DOC_INDEX_GATEWAY_SET ${INDEX_INSTANCE} through gateway ${id}`,
    });
  } catch (err) {
    logEvent(
      "DOC_INDEX_GATEWAY_FAILED",
      { message: `DOC_INDEX_GATEWAY_FAILED ${errorMessage(err)}` },
      { level: "error" },
    );
  }
}

async function watermark(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT count(*) AS n, max(updated_at) AS at, max(id) AS top FROM documents")
    .first<{ n: number; at: string | null; top: number | null }>();
  return `${row?.n ?? 0}|${row?.at ?? ""}|${row?.top ?? 0}`;
}

/**
 * Start a sync when the store changed since the last one started. A sync already running answers
 * the request with itself, and it may have read past this change, so the watermark is kept only
 * for a sync that began after the store was read; otherwise the next tick asks again.
 */
export async function docIndexTick(env: Env): Promise<IndexReport> {
  const ns = env.AI_SEARCH;
  if (!ns) return idle("AI_SEARCH is not bound");
  let instance: AiSearchInstance;
  try {
    instance = await ensureInstance(env, ns);
  } catch (err) {
    return { ran: true, note: `the instance refused its query: ${errorMessage(err)}`, failed: 1 };
  }
  await routeThroughGateway(env, instance);
  const asked = Math.floor(Date.now() / 1000) * 1000;
  const mark = await watermark(env.DB);
  if ((await env.APP_KV.get(SYNCED_KEY)) === mark) return idle("nothing changed");
  let job: AiSearchJobInfo;
  try {
    job = await instance.jobs.create({ description: "documents changed" });
  } catch (err) {
    return { ran: true, note: `sync refused: ${errorMessage(err)}`, failed: 1 };
  }
  const started = Date.parse(`${job.started_at?.replace(" ", "T")}Z`);
  if (started >= asked) {
    await env.APP_KV.put(SYNCED_KEY, mark);
    return { ran: true, note: `sync ${job.id} started`, failed: 0 };
  }
  return idle(`sync ${job.id} already running`);
}

// The index decides only the order: every hit is read back from D1 with the caller's filters, so a
// document the caller may not see, or one deleted or moved since indexing, is never returned.
export const HYBRID_MONTHLY_CAP = 5000;
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const SNIPPET_CHARS = 240;
const RETIRED = ["closed", "superseded"];

const countKey = (now: Date) => `doc-index:queries:${now.toISOString().slice(0, 7)}`;

export async function aiSearchUsage(
  env: Env,
  now: Date = new Date(),
): Promise<{ month: string; hybrid: number; cap: number }> {
  return {
    month: now.toISOString().slice(0, 7),
    hybrid: Number((await env.APP_KV.get(countKey(now))) ?? 0),
    cap: HYBRID_MONTHLY_CAP,
  };
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
  now: Date = new Date(),
): Promise<HybridRow[] | string> {
  const ns = env.AI_SEARCH;
  if (!ns) return "AI_SEARCH is not bound";
  if ((await env.APP_KV.get(READY_KEY)) !== INDEX_QUERY) return "the search index is not built yet";
  const key = countKey(now);
  const used = Number((await env.APP_KV.get(key)) ?? 0);
  if (used >= HYBRID_MONTHLY_CAP)
    return `this month's ${HYBRID_MONTHLY_CAP} hybrid queries are used`;
  await env.APP_KV.put(key, String(used + 1), { expirationTtl: 40 * 86_400 });

  const filters: Record<string, { $eq: string } | { $nin: string[] }> = {};
  if (filter.namespace) filters.namespace = { $eq: filter.namespace };
  if (filter.type) filters.type = { $eq: filter.type };
  if (!filter.includeRetired) filters.status = { $nin: RETIRED };
  let chunks: AiSearchSearchResponse["chunks"];
  // AI Search's binding takes no signal, so the search and its reranker are raced against a
  // deadline.
  let timer: number | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${SEARCH_TIMEOUT_MS} ms`)),
      SEARCH_TIMEOUT_MS,
    ) as unknown as number;
  });
  try {
    const search = ns.get(INDEX_INSTANCE).search({
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
        // A cross-encoder reorders the fused candidates by how well each answers the query, the step the
        // usual hybrid pipeline adds after fusion. Threshold 0: it reorders, it never drops a candidate
        // the fusion found.
        reranking: { enabled: true, model: RERANK_MODEL, match_threshold: 0 },
      },
    });
    ({ chunks } = await Promise.race([search, late]));
  } catch (err) {
    // The upstream error goes to the log only; the caller is told what happened, never the raw text of
    // another service's answer.
    const message = errorMessage(err);
    logEvent(
      "DOC_INDEX_SEARCH_FAILED",
      { message: `DOC_INDEX_SEARCH_FAILED ${message}` },
      { level: "warn" },
    );
    return "the search index did not answer";
  } finally {
    clearTimeout(timer);
  }

  // Best chunk first, so a document's first chunk sets its rank and its snippet; every chunk of it
  // adds to how it matched.
  const ranked = new Map<number, { snippet: string; match: Match }>();
  for (const chunk of chunks) {
    const id = Number(chunk.item.metadata?.row_id);
    if (!Number.isInteger(id)) continue;
    const seen = ranked.get(id);
    if (seen) seen.match = joinMatch(seen.match, matchOf(chunk));
    else
      ranked.set(id, {
        snippet: chunk.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
        match: matchOf(chunk),
      });
  }
  if (ranked.size === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, namespace, path, title, type, status, updated_at FROM documents
     WHERE id IN (SELECT value FROM json_each(?1))
       AND (?2 IS NULL OR namespace = ?2)
       AND (?3 IS NULL OR type = ?3)
       AND (?4 IS NULL OR path IN (SELECT value FROM json_each(?4)))
       AND (?5 = 1 OR status IS NULL OR status NOT IN (SELECT value FROM json_each(?6)))`,
  )
    .bind(
      JSON.stringify([...ranked.keys()]),
      filter.namespace,
      filter.type,
      filter.allowed,
      filter.includeRetired ? 1 : 0,
      JSON.stringify(RETIRED),
    )
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
