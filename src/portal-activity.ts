import { auditDetail } from "./audit-detail";
import { queryParam } from "./portal-auth";
import type { AuditDetail } from "./ops-types/portal";

// Recent activity: a bounded, filtered read of audit_log across every namespace, for Capsid
// Portal's Activity view. The filter comes off a query string, so every value is a bound parameter;
// the test asserts the statement's shape as well as its results.

export const ACTIVITY_LIMIT = 50;

export interface ActivityFilter {
  namespace: string | null;
  actor: string | null;
  id: number | null;
}

export interface ActivityRow {
  id: number;
  at: string;
  actor: string | null;
  client: string | null;
  action: string | null;
  namespace: string | null;
  path: string | null;
  detail: AuditDetail;
}

// An audit row id: a positive whole number, as the autoincrement writes it.
const ROW_ID = /^[1-9][0-9]{0,15}$/;

// The filter, or why the query string cannot be one. An id that is not a row id is refused rather
// than dropped, which would answer with the whole log instead.
export function activityFilterFrom(
  url: URL,
): { ok: true; filter: ActivityFilter } | { ok: false; refusal: string } {
  const id = queryParam(url, "id");
  if (id !== null && !ROW_ID.test(id))
    return {
      ok: false,
      refusal: `id must be an audit row id, a positive whole number; got ${JSON.stringify(id.slice(0, 40))}.`,
    };
  return {
    ok: true,
    filter: {
      namespace: queryParam(url, "namespace"),
      actor: queryParam(url, "actor"),
      id: id === null ? null : Number(id),
    },
  };
}

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
      `SELECT id, at, actor, client, action, namespace, path, params FROM audit_log ${clause} ORDER BY id DESC LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<Omit<ActivityRow, "detail"> & { params: string | null }>();
  // The params never leave here: each row carries its named fields instead.
  return (results ?? []).map(({ params, ...row }) => ({ ...row, detail: auditDetail(params) }));
}
