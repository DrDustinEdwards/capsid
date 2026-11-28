import { normalizeDashes } from "./normalize";
import { auditStatement, snapshotLive } from "./store-guards";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// A system document write (a job's mirror document) under the same two invariants as every other
// write path (snapshot invariant, test/write-invariants.test.ts): the prior row is snapshotted
// into document_versions and audit_log gets a row, in the same batch as the write, so all three
// land or none do.
export async function docStatements(
  db: D1Database,
  doc: {
    namespace: string;
    path: string;
    title: string;
    body: string;
    type: string;
    status?: string;
    tags: string;
    prior: { id: number; title: string | null; body: string | null } | null;
    action: string;
    // Who the audit row names: the job's actor, because audit_log is the one place that answers who
    // did it.
    actor: string;
  },
): Promise<D1PreparedStatement[]> {
  const body = normalizeDashes(doc.body, "prose");
  const title = normalizeDashes(doc.title, "title");

  // The snapshot selects the live row inside the batch rather than binding doc.prior, read earlier:
  // a write landing in between (the job claim path waits on GitHub there) is still snapshotted. With
  // no row it inserts nothing.
  const statements: D1PreparedStatement[] = [snapshotLive(db, doc.namespace, doc.path)];
  statements.push(
    db
      .prepare(
        `INSERT INTO documents (namespace, path, title, body, type, tags, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(namespace, path) DO UPDATE SET
           title = ?3, body = excluded.body, type = ?5, tags = ?6, status = ?7,
           updated_at = datetime('now')`,
      )
      .bind(doc.namespace, doc.path, title, body, doc.type, doc.tags, doc.status ?? "published"),
  );
  statements.push(
    auditStatement(db, doc.actor, doc.action, doc.namespace, doc.path, {
      bytes: body.length,
      sha256: await sha256Hex(body),
      updated: Boolean(doc.prior),
    }),
  );
  return statements;
}

export async function priorDoc(
  db: D1Database,
  namespace: string,
  path: string,
): Promise<{ id: number; title: string | null; body: string | null } | null> {
  return db
    .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ id: number; title: string | null; body: string | null }>();
}
