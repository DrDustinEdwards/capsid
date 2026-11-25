export const CLAIMS_EXPORT_TABLES = [
  "job_claims",
  "job_evaluations",
  "job_touches",
  "job_outcomes",
] as const;
export type ClaimsExportTable = (typeof CLAIMS_EXPORT_TABLES)[number];

export const CLAIMS_EXPORT_MAX = 500;

export interface ClaimsExportPage {
  table: ClaimsExportTable;
  after: number;
  limit: number;
  rows: Record<string, unknown>[];
  next_after: number | null;
}

function isClaimsExportTable(value: unknown): value is ClaimsExportTable {
  return typeof value === "string" && (CLAIMS_EXPORT_TABLES as readonly string[]).includes(value);
}

// The cursor is the row's id, which AUTOINCREMENT never reuses. its rows are never deleted, so a
// rowid a page has passed is never handed out again.
function exportStatement(db: D1Database, table: ClaimsExportTable): D1PreparedStatement {
  switch (table) {
    case "job_claims":
      return db.prepare("SELECT * FROM job_claims WHERE id > ?1 ORDER BY id LIMIT ?2");
    case "job_evaluations":
      return db.prepare("SELECT * FROM job_evaluations WHERE id > ?1 ORDER BY id LIMIT ?2");
    case "job_touches":
      return db.prepare("SELECT * FROM job_touches WHERE id > ?1 ORDER BY id LIMIT ?2");
    case "job_outcomes":
      return db.prepare(
        "SELECT rowid AS rowid, * FROM job_outcomes WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
      );
  }
}

/**
 * One page of a table, strictly after the cursor, oldest first. Pages never skip or repeat a row:
 * each asks for the rows past the last one it was handed.
 */
export async function exportClaimsPage(
  db: D1Database,
  table: ClaimsExportTable,
  after: number,
  limit: number,
): Promise<ClaimsExportPage> {
  if (!isClaimsExportTable(table))
    throw new Error(
      `'${String(table)}' is not an exportable table. One of: ${CLAIMS_EXPORT_TABLES.join(", ")}.`,
    );
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error(`after must be a non-negative integer cursor; got ${after}.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLAIMS_EXPORT_MAX) {
    throw new Error(`limit must be an integer from 1 to ${CLAIMS_EXPORT_MAX}; got ${limit}.`);
  }
  const { results } = await exportStatement(db, table)
    .bind(after, limit + 1)
    .all<Record<string, unknown>>();
  const all = results ?? [];
  const rows = all.slice(0, limit);
  const cursorColumn = table === "job_outcomes" ? "rowid" : "id";
  const last = rows.length ? rows[rows.length - 1][cursorColumn] : null;
  if (all.length > limit && typeof last !== "number") {
    throw new Error(
      `${table} returned a row with no numeric ${cursorColumn}, so the next page cannot be asked for`,
    );
  }
  return { table, after, limit, rows, next_after: all.length > limit ? (last as number) : null };
}
