import { SEARCH_ROWS } from "./limits";

// The document reads the docs tool (src/tools/docs-read.ts) and the Portal's Library
// (src/portal-library.ts) share, so the two cannot disagree about what a search finds,
// what a document holds or which edges touch it (conventions 1.2, never build the same
// thing twice).

export interface DocumentRow {
  id: number;
  namespace: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
  body: string;
}

export interface SearchRow {
  id: number;
  namespace: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  updated_at: string;
  snippet: string;
}

export interface DocumentEdges {
  outgoing: Array<{ type: string; to_ns: string; to_path: string }>;
  incoming: Array<{ type: string; from_ns: string; from_path: string }>;
}

/** One document by namespace and path, or null. Named columns: frontmatter and
 *  publish_at are left out, since nothing in this server reads or writes them. */
export async function readDocument(db: D1Database, namespace: string, path: string): Promise<DocumentRow | null> {
  return db
    .prepare(
      `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at, body
       FROM documents WHERE namespace = ?1 AND path = ?2`
    )
    .bind(namespace, path)
    .first<DocumentRow>();
}

/** The typed edges declared on a document and the ones pointing at it. */
export async function documentEdges(db: D1Database, namespace: string, path: string): Promise<DocumentEdges> {
  const [outgoing, incoming] = await Promise.all([
    db
      .prepare("SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = ?2 ORDER BY type, to_ns, to_path")
      .bind(namespace, path)
      .all<DocumentEdges["outgoing"][number]>(),
    db
      .prepare("SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = ?2 ORDER BY type, from_ns, from_path")
      .bind(namespace, path)
      .all<DocumentEdges["incoming"][number]>(),
  ]);
  return { outgoing: outgoing.results, incoming: incoming.results };
}

export interface SearchFilter {
  namespace: string | null;
  type: string | null;
  /** A JSON array of the only paths a row may have, or null for no such limit. */
  allowed: string | null;
  /** The marks snippet() puts around a matched word. The docs tool's answer uses [ and ];
   *  the Portal passes marks no document text holds, so a bracket in the text (a Markdown
   *  link, say) is never read as a match. */
  marks?: { open: string; close: string };
}

/** Full text search, ranked by bm25, at most SEARCH_ROWS + 1 rows, so a caller can tell
 *  "exactly the limit" from "there are more". Hyphens, quotes and bare AND, OR and NOT
 *  are FTS5 syntax, so a query FTS5 refuses is retried once as a quoted phrase, and plain
 *  text is always a safe input. A second refusal throws. */
export async function searchDocuments(db: D1Database, query: string, filter: SearchFilter): Promise<SearchRow[]> {
  const run = (match: string) =>
    db
      .prepare(
        `SELECT d.id, d.namespace, d.path, d.title, d.type, d.status, d.updated_at,
                snippet(documents_fts, 1, ?6, ?7, ' ... ', 16) AS snippet
         FROM documents_fts
         JOIN documents d ON d.id = documents_fts.rowid
         WHERE documents_fts MATCH ?1
           AND (?2 IS NULL OR d.namespace = ?2)
           AND (?3 IS NULL OR d.type = ?3)
           AND (?4 IS NULL OR d.path IN (SELECT value FROM json_each(?4)))
         ORDER BY bm25(documents_fts)
         LIMIT ?5`
      )
      .bind(match, filter.namespace, filter.type, filter.allowed, SEARCH_ROWS + 1, filter.marks?.open ?? "[", filter.marks?.close ?? "]")
      .all<SearchRow>();
  try {
    return (await run(query)).results;
  } catch {
    return (await run(`"${query.replace(/"/g, '""')}"`)).results;
  }
}
