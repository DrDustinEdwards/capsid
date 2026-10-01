import { auditDetail } from "./audit-detail";
import type { AuditDetail } from "./ops-types";

// Recent activity: a bounded, filtered read of audit_log across every namespace, for
// Capsid Portal's Activity view. The filter comes off a query string, so every value is a
// bound parameter; the test asserts the statement's shape as well as its results. One
// row by id is what the Activity drawer reads (?id=), through the primary key.

export const ACTIVITY_LIMIT = 50;

export interface ActivityFilter {
  namespace: string | null;
  actor: string | null;
  id: number | null;
}

// What an audit row records, where the row says. A job transition writes two rows with
// one action, actor and path: one for the job (params carry job_id) and one for its
// mirror document (params carry the body's sha256, as every document write does).
// null when the params name neither, or are not JSON.
export type ActivityTarget = "job" | "document";

export interface ActivityRow {
  id: number;
  at: string;
  actor: string | null;
  action: string | null;
  namespace: string | null;
  path: string | null;
  target: ActivityTarget | null;
  detail: AuditDetail;
}

function param(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  // An empty value is no filter, not a filter on the empty string.
  return trimmed.length ? trimmed : null;
}

// An audit row id: a positive whole number, as the autoincrement writes it.
const ROW_ID = /^[1-9][0-9]{0,15}$/;

/** The filter, or why the query string cannot be one. An id that is not a row id is
 *  refused rather than dropped, which would answer with the whole log instead. */
export function activityFilterFrom(url: URL): { ok: true; filter: ActivityFilter } | { ok: false; refusal: string } {
  const id = param(url, "id");
  if (id !== null && !ROW_ID.test(id)) return { ok: false, refusal: `id must be an audit row id, a positive whole number; got ${JSON.stringify(id.slice(0, 40))}.` };
  return { ok: true, filter: { namespace: param(url, "namespace"), actor: param(url, "actor"), id: id === null ? null : Number(id) } };
}

// json_valid first: json_extract on a params value that is not JSON would fail the
// whole read, and rows written before params were always JSON exist.
const TARGET_SQL = `CASE WHEN NOT json_valid(params) THEN NULL
  WHEN json_extract(params, '$.job_id') IS NOT NULL THEN 'job'
  WHEN json_extract(params, '$.sha256') IS NOT NULL THEN 'document'
  ELSE NULL END`;

export async function loadActivity(db: D1Database, filter: ActivityFilter): Promise<ActivityRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.id !== null) {
    binds.push(filter.id);
    where.push(`id = ?${binds.length}`);
  } else if (filter.namespace) {
    binds.push(filter.namespace);
    where.push(`namespace = ?${binds.length}`);
  }
  if (filter.id === null && filter.actor) {
    binds.push(filter.actor);
    where.push(`actor = ?${binds.length}`);
  }
  binds.push(ACTIVITY_LIMIT);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // ORDER BY id, not `at`: `at` is text written in two formats, and the
  // autoincrement id is what orders rows as they happened.
  const { results } = await db
    .prepare(
      `SELECT id, at, actor, action, namespace, path, ${TARGET_SQL} AS target, params FROM audit_log ${clause} ORDER BY id DESC LIMIT ?${binds.length}`
    )
    .bind(...binds)
    .all<Omit<ActivityRow, "detail"> & { params: string | null }>();
  // The params never leave here: each row carries its named fields instead.
  return (results ?? []).map(({ params, ...row }) => ({ ...row, detail: auditDetail(params) }));
}
