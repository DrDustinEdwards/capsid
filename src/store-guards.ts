import { sha256Hex } from "./auth";

// INSERT that violates NOT NULL, guarded by NOT EXISTS, so a missing row aborts
// the batch. A pre-read is a different transaction. meta.changes is inflated by
// FTS5 triggers and cannot count what a batch did.
const GUARD_VIOLATION = "document_versions.document_id";
export function requireExists(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE NOT EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`
    )
    .bind(namespace, path);
}

// The same abort for a job transition, as the first statement of the batch that
// carries the UPDATE and every record of it. It fires unless the row is still in the
// status and holder the caller read, at the updated_at the caller read, so the
// mirror, audit and outcome rows built from that read commit only with the UPDATE
// they describe. updated_at moves on every job UPDATE, so any change in between aborts.
export function requireJobUnchanged(
  db: D1Database,
  id: string,
  status: string,
  claimedBy: string | null,
  updatedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, 'jobs', ?1
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND status = ?2 AND claimed_by IS ?3 AND updated_at = ?4)`
    )
    .bind(id, status, claimedBy, updatedAt);
}

export function isMissingRowAbort(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(GUARD_VIOLATION);
}

// Body equality rather than a stored sha column. `IS` rather than `=` because a
// NULL body is legitimate and `body = NULL` is never true.
export function requireBodyUnchanged(
  db: D1Database,
  namespace: string,
  path: string,
  expectedBody: string | null
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE NOT EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2 AND body IS ?3)`
    )
    .bind(namespace, path, expectedBody);
}

function requireMissing(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, ?2
       WHERE EXISTS (SELECT 1 FROM documents WHERE namespace = ?1 AND path = ?2)`
    )
    .bind(namespace, path);
}

// THE SNAPSHOT OF THE LIVE ROW, ONE SPELLING (audit 2026-09-25, E1-2). It SELECTs the
// row the table holds when the batch runs, not a body the caller read earlier, so a
// write landing between a pre-read and the batch is snapshotted rather than lost. It
// inserts nothing when no row exists, so a caller can add it unconditionally.
// RETURNING id tells a caller whether a snapshot was taken (see snapshotTaken).
export function snapshotLive(db: D1Database, namespace: string, path: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path, title, body)
       SELECT id, namespace, path, title, body FROM documents WHERE namespace = ?1 AND path = ?2
       RETURNING id`
    )
    .bind(namespace, path);
}

// Whether a snapshotLive statement inserted a row, from its batch result. Read from
// RETURNING rather than meta.changes, which the FTS5 triggers inflate.
export function snapshotTaken(result: D1Result | undefined): boolean {
  return (result?.results?.length ?? 0) > 0;
}

type WriteGuard = "none" | "body" | "missing";

type CommitRefusals = {
  ifMatchOnMissing: string;
  ifMatchMismatch: (currentSha: string, passed: string) => string;
  createCollision: string;
  deletedInFlight: string;
  bodyChanged: (currentSha: string, elicited: boolean) => string;
  batchFailed: (reason: string) => string;
};

export function guardedCommit(opts: {
  db: D1Database;
  namespace: string;
  path: string;
  prior: { body: string | null } | null;
  if_match: string | undefined;
  refusals: CommitRefusals;
}) {
  const { db, namespace, path, prior, if_match, refusals } = opts;
  return {
    async precheckIfMatch(): Promise<string | null> {
      if (if_match === undefined) return null;
      if (!prior) return refusals.ifMatchOnMissing;
      const currentSha = await sha256Hex(prior.body ?? "");
      const passed = if_match.trim().toLowerCase();
      return currentSha === passed ? null : refusals.ifMatchMismatch(currentSha, passed);
    },
    // Either the refusal, or the batch results of the caller's own statements in the
    // order given (the armed guard's result is dropped), so a caller can report what a
    // statement with RETURNING did.
    async run(
      elicited: boolean,
      statements: D1PreparedStatement[]
    ): Promise<{ refusal: string } | { results: D1Result[] }> {
      let guard: WriteGuard = "none";
      const armed: D1PreparedStatement[] = [];
      if (!prior) {
        guard = "missing";
        armed.push(requireMissing(db, namespace, path));
      } else if (if_match !== undefined || elicited) {
        guard = "body";
        armed.push(requireBodyUnchanged(db, namespace, path, prior.body));
      }
      try {
        const results = await db.batch([...armed, ...statements]);
        return { results: results.slice(armed.length) };
      } catch (err) {
        if (!isMissingRowAbort(err)) {
          return { refusal: refusals.batchFailed(err instanceof Error ? err.message : String(err)) };
        }
        if (guard === "missing") return { refusal: refusals.createCollision };
        const current = await db
          .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
          .bind(namespace, path)
          .first<{ body: string | null }>();
        if (!current) return { refusal: refusals.deletedInFlight };
        return { refusal: refusals.bodyChanged(await sha256Hex(current.body ?? ""), elicited) };
      }
    },
  };
}

// THE DOCUMENT UPSERT, ONE SPELLING. `write` and `lint` mode `report` both store a
// document and both have to store it the same way, or two write paths disagree about
// what a write is. The split of 2026-09-10 put them in different files, which is
// where a second spelling comes from.
//
// COALESCE on every optional column, so an argument the caller did not supply leaves
// the stored value alone rather than nulling it. The improve loop's own writer is
// deliberately NOT folded in here: it always sets every column and has no COALESCE.
//
// test/mutation-guard-coverage.test.ts and test/tool-annotations.test.ts both match
// this call as a mutation marker, the same way they match pathMutation().
export function documentUpsert(
  db: D1Database,
  namespace: string,
  path: string,
  title: string | null,
  body: string,
  type: string | null,
  tags: string | null,
  status: string | null
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO documents (namespace, path, title, body, type, tags, status)
       VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'note'), ?6, COALESCE(?7, 'published'))
       ON CONFLICT(namespace, path) DO UPDATE SET
         title = COALESCE(?3, documents.title),
         body = excluded.body,
         type = COALESCE(?5, documents.type),
         tags = COALESCE(?6, documents.tags),
         status = COALESCE(?7, documents.status),
         updated_at = datetime('now')`
    )
    .bind(namespace, path, title, body, type, tags, status);
}

// THE AUDIT ROW, ONE SPELLING (audit 2026-09-25, E1-24). Every write path appends one
// (the snapshot rule in CLAUDE.md), and the INSERT was spelled out at about fifteen
// sites. params is
// stored as JSON. An audit row whose params come from inside the batch (delete's
// edges, a skill transition guarded by its new status) is an INSERT ... SELECT and
// keeps its own statement.
export function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  namespace: string | null,
  path: string | null,
  params: unknown
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(actor, action, namespace, path, JSON.stringify(params));
}
