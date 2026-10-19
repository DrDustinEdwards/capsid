import { isCanonPath } from "./canon";
import type { Env } from "./env";
import { auditStatement, snapshotLive } from "./store-guards";

// The daily supersede pass (capsid/research/design-hybrid-search.md 3.3). A document
// that a live document `supersedes` or `replaces` (src/links.ts) is marked superseded,
// so search hides it by default and the current answer is not shown beside the old
// one. Each change is an ordinary write: the live row is snapshotted, the status set,
// and an audit row names the edge (CLAUDE.md, snapshot rule). It never deletes and
// never reverses itself. To un-supersede a document, remove the edge as well as editing
// the status, or the next pass sets it again.
//
// Canon (src/canon.ts) is never marked: a driver may write an edge in its own namespace
// but may not change that namespace's core.md or decisions.md, so an edge to one must
// not do it on the driver's behalf (Grok audit 2026-10, M4). The seat changes a canon
// document's status itself. The write path refuses such an edge, and a cross-namespace
// one the writer cannot write, before it is stored (src/tools/docs-write.ts).

export const SUPERSEDE_ACTOR = "system:supersede-pass";
// Documents changed per pass, so a bad edge set changes a bounded number.
export const SUPERSEDE_MAX = 50;
// Rows read per pass. Canon targets are read and skipped, and are never marked, so they
// would hold the window forever if it were only SUPERSEDE_MAX + 1 wide.
const SUPERSEDE_READ = SUPERSEDE_MAX * 4;

const LIVE_SOURCE = ["draft", "superseded", "closed"];

interface Target {
  namespace: string;
  path: string;
  status: string | null;
  from_ns: string;
  from_path: string;
  type: string;
}

export interface SupersedeReport {
  marked: Array<{ document: string; by: string }>;
  // Canon targets an edge names, left as they are.
  skipped_canon: string[];
  more: boolean;
}

export async function supersedePass(env: Env): Promise<SupersedeReport> {
  const { results } = await env.DB.prepare(
    `SELECT d.namespace, d.path, d.status, l.from_ns, l.from_path, l.type
     FROM document_links l
     JOIN documents s ON s.namespace = l.from_ns AND s.path = l.from_path
     JOIN documents d ON d.namespace = l.to_ns AND d.path = l.to_path
     WHERE l.type IN ('supersedes', 'replaces')
       AND COALESCE(s.status, 'published') NOT IN (SELECT value FROM json_each(?1))
       AND COALESCE(d.status, 'published') NOT IN ('superseded', 'closed')
     ORDER BY d.namespace, d.path
     LIMIT ?2`
  )
    .bind(JSON.stringify(LIVE_SOURCE), SUPERSEDE_READ)
    .all<Target>();
  const skipped = new Set<string>();
  const targets = results.filter((t) => {
    if (!isCanonPath(t.namespace, t.path)) return true;
    skipped.add(`${t.namespace}/${t.path}`);
    return false;
  });
  const marked: SupersedeReport["marked"] = [];
  const seen = new Set<string>();
  for (const t of targets.slice(0, SUPERSEDE_MAX)) {
    const document = `${t.namespace}/${t.path}`;
    if (seen.has(document)) continue;
    seen.add(document);
    const by = `${t.from_ns}/${t.from_path}`;
    await env.DB.batch([
      snapshotLive(env.DB, t.namespace, t.path),
      env.DB.prepare(
        `UPDATE documents SET status = 'superseded', updated_at = datetime('now')
         WHERE namespace = ?1 AND path = ?2 AND COALESCE(status, 'published') NOT IN ('superseded', 'closed')`
      ).bind(t.namespace, t.path),
      auditStatement(env.DB, SUPERSEDE_ACTOR, "write", t.namespace, t.path, { status: "superseded", prior_status: t.status, superseded_by: by, link: t.type }),
    ]);
    marked.push({ document, by });
  }
  return { marked, skipped_canon: [...skipped], more: targets.length > SUPERSEDE_MAX || results.length === SUPERSEDE_READ };
}
