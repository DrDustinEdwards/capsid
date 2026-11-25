import { SEARCH_ROWS } from "./limits";

// Reads shared by the docs tool and the Portal Library so they cannot disagree on search, content or edges.

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

export async function readDocument(
  db: D1Database,
  namespace: string,
  path: string,
): Promise<DocumentRow | null> {
  return db
    .prepare(
      `SELECT id, namespace, path, title, type, status, tags, created_at, updated_at, body
       FROM documents WHERE namespace = ?1 AND path = ?2`,
    )
    .bind(namespace, path)
    .first<DocumentRow>();
}

export async function documentEdges(
  db: D1Database,
  namespace: string,
  path: string,
): Promise<DocumentEdges> {
  const [outgoing, incoming] = await Promise.all([
    db
      .prepare(
        "SELECT type, to_ns, to_path FROM document_links WHERE from_ns = ?1 AND from_path = ?2 ORDER BY type, to_ns, to_path",
      )
      .bind(namespace, path)
      .all<DocumentEdges["outgoing"][number]>(),
    db
      .prepare(
        "SELECT type, from_ns, from_path FROM document_links WHERE to_ns = ?1 AND to_path = ?2 ORDER BY type, from_ns, from_path",
      )
      .bind(namespace, path)
      .all<DocumentEdges["incoming"][number]>(),
  ]);
  return { outgoing: outgoing.results, incoming: incoming.results };
}

export interface SearchFilter {
  namespace: string | null;
  type: string | null;
  allowed: string | null;
  // The marks snippet() puts around a match: [ and ] for the docs tool; the Portal passes marks no text holds.
  marks?: { open: string; close: string };
}

// bm25-ranked, SEARCH_ROWS + 1 rows so a caller can tell "exactly the limit" from "more". FTS5 syntax (hyphens,
// quotes, bare AND/OR/NOT) is refused once and retried as a quoted phrase; a second refusal throws.
export async function searchDocuments(
  db: D1Database,
  query: string,
  filter: SearchFilter,
): Promise<SearchRow[]> {
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
         LIMIT ?5`,
      )
      .bind(
        match,
        filter.namespace,
        filter.type,
        filter.allowed,
        SEARCH_ROWS + 1,
        filter.marks?.open ?? "[",
        filter.marks?.close ?? "]",
      )
      .all<SearchRow>();
  try {
    return (await run(query)).results;
  } catch {
    return (await run(`"${query.replace(/"/g, '""')}"`)).results;
  }
}
