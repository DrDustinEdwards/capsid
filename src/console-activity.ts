// Recent activity: a bounded, filtered read of audit_log across every namespace, for
// the console. The filter comes off a query string, so both values are bound
// parameters; the test asserts the statement's shape as well as its results.

export const ACTIVITY_LIMIT = 50;

export interface ActivityFilter {
  namespace: string | null;
  actor: string | null;
}

export interface ActivityRow {
  at: string;
  actor: string | null;
  action: string | null;
  namespace: string | null;
  path: string | null;
}

function param(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  // An empty value is no filter, not a filter on the empty string.
  return trimmed.length ? trimmed : null;
}

export function activityFilterFrom(url: URL): ActivityFilter {
  return { namespace: param(url, "namespace"), actor: param(url, "actor") };
}

export async function loadActivity(db: D1Database, filter: ActivityFilter): Promise<ActivityRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.namespace) {
    binds.push(filter.namespace);
    where.push(`namespace = ?${binds.length}`);
  }
  if (filter.actor) {
    binds.push(filter.actor);
    where.push(`actor = ?${binds.length}`);
  }
  binds.push(ACTIVITY_LIMIT);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // ORDER BY id, not `at`: `at` is text written in two formats, and the
  // autoincrement id is what orders rows as they happened.
  const { results } = await db
    .prepare(`SELECT at, actor, action, namespace, path FROM audit_log ${clause} ORDER BY id DESC LIMIT ?${binds.length}`)
    .bind(...binds)
    .all<ActivityRow>();
  return results ?? [];
}
