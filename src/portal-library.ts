import type { Env } from "./env";
import { documentEdges, readDocument, searchDocuments } from "./doc-reads";
import { MAX_NAMESPACE, MAX_QUERY, MAX_ROWS, pathProblem, SEARCH_ROWS } from "./limits";
import { OPS_RETURN_TO } from "./ops-feed";
import type { LibraryEntry, LibraryShelf, PortalLibrary } from "./ops-types";
import { portalGate } from "./portal-auth";
import { jsonResponse as json } from "./http";

// The Portal's Library: GET /portal/api/library, read-only, over the knowledge store
// (capsid/decisions.md 2026-10-09, Portal review item 4: "The knowledge store is NOT
// chat-only: it gets the read-only Library page"; experience review answer 11: search,
// decisions, rulings, research, links to jobs). Writing stays in chat and with drivers.
// Search, one document and its edges go through src/doc-reads.ts, the readers behind
// capsid_find_docs and capsid_read_doc, so the Library and chat cannot disagree. A route,
// not a tool, so no grant is checked here (CLAUDE.md, one enforcement point rule): it
// answers to portalGate, and src/scope.ts lists it among the routes gated some other way.
// It writes nothing, not even the conventions-read row: that row records an agent
// loading the rules, and the Portal is the administrator reading them.

export const PORTAL_LIBRARY_PATH = "/portal/api/library";

// The marks around a matched word in a search's snippet: control characters no document
// holds, so brackets in the text (a Markdown link) are never taken for a match.
const LIBRARY_MARK_OPEN = "\u0002";
const LIBRARY_MARK_CLOSE = "\u0003";

/** Which shelf a row belongs on: a decision record first, then by its folder. */
function shelfOf(row: Pick<LibraryEntry, "type" | "path">): LibraryShelf {
  if (row.type === "decision") return "decisions";
  return row.path.startsWith("rulings/") ? "rulings" : "research";
}

function param(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name)?.trim();
  return raw ? raw : null;
}

/** GET /portal/api/library: the shelves, ?q= a search, or ?ns=&path= one document. */
export async function handlePortalLibrary(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const url = new URL(request.url);
  const generated = now.toISOString();
  const q = param(url, "q");
  const ns = param(url, "ns");
  const path = param(url, "path");

  if (ns !== null || path !== null) {
    if (ns === null || path === null) return json({ error: "A document is named by both ns and path." }, 400);
    if (ns.length > MAX_NAMESPACE) return json({ error: `ns is longer than ${MAX_NAMESPACE} characters.` }, 400);
    const problem = pathProblem(path);
    if (problem) return json({ error: `${problem}.` }, 400);
    const [row, edges] = await Promise.all([readDocument(env.DB, ns, path), documentEdges(env.DB, ns, path)]);
    if (!row) return json({ error: `No document ${ns}/${path}.` }, 404);
    const { id: _id, ...doc } = row;
    const body: PortalLibrary = { kind: "document", generated, doc, ...edges };
    return json(body);
  }

  if (q !== null) {
    if (q.length > MAX_QUERY) return json({ error: `The search is longer than ${MAX_QUERY} characters.` }, 400);
    let rows: Awaited<ReturnType<typeof searchDocuments>>;
    try {
      rows = await searchDocuments(env.DB, q, { namespace: null, type: null, allowed: null, marks: { open: LIBRARY_MARK_OPEN, close: LIBRARY_MARK_CLOSE } });
    } catch (err) {
      // A query FTS5 refuses is retried as a quoted phrase, which it always accepts, so a
      // second refusal is the store failing, not the caller's input.
      return json({ error: `The search could not run: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    const truncated = rows.length > SEARCH_ROWS;
    const body: PortalLibrary = {
      kind: "search",
      generated,
      query: q,
      rows: rows.slice(0, SEARCH_ROWS).map(({ id: _id, ...r }) => r),
      truncated,
    };
    return json(body);
  }

  // The shelves, one statement over every namespace, written inline so the query-plan
  // walk reads it. ORDER BY namespace, path walks the (namespace, path) unique
  // index, so the read stops at the LIMIT and never bare-scans documents
  // (test-integration/query-plans.test.ts). archive/ is history, not a shelf.
  const { results } = await env.DB.prepare(
    `SELECT namespace, path, title, type, status, updated_at
     FROM documents
     WHERE (type = 'decision' OR path GLOB 'rulings/*' OR path GLOB 'research/*') AND path NOT GLOB 'archive/*'
     ORDER BY namespace, path
     LIMIT ?1`
  )
    .bind(MAX_ROWS + 1)
    .all<LibraryEntry>();
  const shelves: Record<LibraryShelf, LibraryEntry[]> = { decisions: [], rulings: [], research: [] };
  for (const row of results.slice(0, MAX_ROWS)) shelves[shelfOf(row)].push(row);
  const body: PortalLibrary = { kind: "shelves", generated, shelves, truncated: results.length > MAX_ROWS };
  return json(body);
}
