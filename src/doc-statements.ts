import { sha256Hex } from "./auth";
import { normalizeDashes } from "./normalize";
import { auditStatement, snapshotLive } from "./store-guards";

// The audit actor of the Worker's own unattended actions (the auto-merge tick, an
// approved merge executed). The string is the improve loop's, which wrote these rows
// first; it is kept so audit_log reads as one series and src/job-touches.ts still
// recognises it.
export const SYSTEM_ACTOR = "improve-loop";

// A system document write (a job's mirror document) under the same two invariants as
// every other write path (CLAUDE.md, snapshot rule): the prior row is snapshotted into
// document_versions and audit_log gets a row, in the same batch as the write, so all
// three land or none do. Returns statements so a caller can batch them with the row
// update they belong to.
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
    // Who the audit row names: the job's actor, because audit_log is the one place that
    // answers who did it.
    actor: string;
  }
): Promise<D1PreparedStatement[]> {
  // Server-side dash normalization, as capsid_write_doc applies.
  const body = normalizeDashes(doc.body, "prose");
  const title = normalizeDashes(doc.title, "title");

  // The snapshot selects the live row inside the batch rather than binding doc.prior,
  // read earlier: a write landing in between (the job claim path waits on GitHub
  // there) is still snapshotted. With no row it inserts nothing.
  const statements: D1PreparedStatement[] = [snapshotLive(db, doc.namespace, doc.path)];
  statements.push(
    db
      .prepare(
        `INSERT INTO documents (namespace, path, title, body, type, tags, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(namespace, path) DO UPDATE SET
           title = ?3, body = excluded.body, type = ?5, tags = ?6, status = ?7,
           updated_at = datetime('now')`
      )
      .bind(doc.namespace, doc.path, title, body, doc.type, doc.tags, doc.status ?? "published")
  );
  statements.push(
    auditStatement(db, doc.actor, doc.action, doc.namespace, doc.path, {
      bytes: body.length,
      sha256: await sha256Hex(body),
      updated: Boolean(doc.prior),
    })
  );
  return statements;
}

export async function priorDoc(
  db: D1Database,
  namespace: string,
  path: string
): Promise<{ id: number; title: string | null; body: string | null } | null> {
  return db
    .prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ id: number; title: string | null; body: string | null }>();
}

// An audit row for a system action that is not a document write (an auto-merge, a
// decline, an approval executed), under SYSTEM_ACTOR, so one query answers what the
// Worker did on its own. An action a person made names that person: `actor` is the
// caller (controls design, finding 5).
export function systemAudit(
  db: D1Database,
  action: string,
  namespace: string | null,
  params: unknown,
  actor: string = SYSTEM_ACTOR
): D1PreparedStatement {
  return auditStatement(db, actor, action, namespace, null, params);
}
